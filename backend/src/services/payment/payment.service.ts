import crypto from 'crypto';
import { dbPool } from '../../config/database.js';
import { RedisInventoryService } from '../inventory.service.js';
import type { PaymentProvider } from './payment-provider.interface.js';
import { DevPaymentProvider } from './dev-payment.provider.js';
import { logger } from '../../utils/logger.js';
import { metrics } from '../../utils/metrics.js';

export interface InitializePaymentParams {
  reservationId: string;
  userId: string;
  idempotencyKey: string;
  simulateSuccess?: boolean;
}

export interface PaymentIntentResult {
  paymentId: string;
  providerPaymentId: string;
  bookingId?: string;
  clientSecret?: string;
  checkoutUrl?: string;
  amountMinor: number;
  currency: string;
  status: 'PENDING' | 'SUCCEEDED' | 'FAILED';
}

export class PaymentService {
  private provider: PaymentProvider;
  private inventoryService: RedisInventoryService;

  constructor(provider?: PaymentProvider) {
    this.provider = provider || new DevPaymentProvider();
    this.inventoryService = new RedisInventoryService();
  }

  /**
   * Initialize a payment intent for an active PENDING reservation.
   */
  async initializePayment(params: InitializePaymentParams): Promise<PaymentIntentResult> {
    const { reservationId, userId, idempotencyKey, simulateSuccess } = params;

    // 1. Fetch reservation from database
    const resQuery = await dbPool.query(
      `SELECT id, user_id, event_session_id, status, expires_at, total_amount_minor, currency
       FROM reservations
       WHERE id = $1;`,
      [reservationId]
    );

    if (resQuery.rows.length === 0) {
      throw new Error('RESERVATION_NOT_FOUND');
    }

    const reservation = resQuery.rows[0];

    // Ownership check
    if (reservation.user_id !== userId) {
      throw new Error('FORBIDDEN_RESERVATION');
    }

    // Status check
    if (reservation.status !== 'PENDING') {
      throw new Error(`RESERVATION_NOT_PAYABLE_${reservation.status}`);
    }

    // Expiration check
    if (new Date() >= new Date(reservation.expires_at)) {
      // Lease has expired!
      throw new Error('RESERVATION_EXPIRED');
    }

    const amountMinor = Number(reservation.total_amount_minor);
    const currency = reservation.currency || 'INR';

    // 2. Call Payment Provider
    const paymentId = crypto.randomUUID();
    const providerResult = await this.provider.createPayment({
      paymentId,
      reservationId,
      userId,
      amountMinor,
      currency,
      description: `DropShield Ticket Booking #${reservationId.slice(0, 8)}`,
      metadata: {
        idempotencyKey,
        simulateImmediateSuccess: simulateSuccess ?? false,
      },
    });

    metrics.increment('payment_initialized_total');

    let bookingId: string | undefined;
    let paymentStatus: 'PENDING' | 'SUCCEEDED' | 'FAILED' = providerResult.status;

    if (simulateSuccess) {
      const finalizeResult = await this.finalizePaymentSuccess({
        reservationId,
        userId,
        providerPaymentId: providerResult.providerPaymentId,
        amountMinor,
        currency,
        idempotencyKey,
      });
      bookingId = finalizeResult.bookingId;
      paymentStatus = 'SUCCEEDED';
    }

    return {
      paymentId,
      providerPaymentId: providerResult.providerPaymentId,
      bookingId,
      clientSecret: providerResult.clientSecret,
      checkoutUrl: providerResult.checkoutUrl,
      amountMinor,
      currency,
      status: paymentStatus,
    };
  }

  /**
   * Finalize a successful payment:
   * Atomically in PostgreSQL:
   * 1. Creates confirmed booking
   * 2. Inserts booking items
   * 3. Inserts payment record (SUCCEEDED)
   * 4. Updates reservation to CONFIRMED
   * 5. Updates session_seats to BOOKED
   * 6. Appends immutable entry to transaction_ledger
   * Then confirms seats in Redis inventory.
   */
  async finalizePaymentSuccess(params: {
    reservationId: string;
    userId: string;
    providerPaymentId: string;
    amountMinor: number;
    currency: string;
    idempotencyKey?: string;
  }): Promise<{ bookingId: string; paymentId: string }> {
    const { reservationId, userId, providerPaymentId, amountMinor, currency } = params;
    const idempotencyKey = params.idempotencyKey || `pay_idemp_${providerPaymentId}`;

    const client = await dbPool.connect();
    const paymentId = crypto.randomUUID();
    const bookingId = crypto.randomUUID();

    try {
      await client.query('BEGIN');

      // 1. Lock reservation row
      const resCheck = await client.query(
        `SELECT id, user_id, event_session_id, status, expires_at, total_amount_minor, currency
         FROM reservations
         WHERE id = $1
         FOR UPDATE;`,
        [reservationId]
      );

      if (resCheck.rows.length === 0) {
        throw new Error('RESERVATION_NOT_FOUND');
      }

      const reservation = resCheck.rows[0];

      // Idempotency: If booking already exists for this reservation, return existing
      const existingBooking = await client.query(
        `SELECT id FROM bookings WHERE reservation_id = $1;`,
        [reservationId]
      );

      if (existingBooking.rows.length > 0) {
        await client.query('ROLLBACK');
        return { bookingId: existingBooking.rows[0].id, paymentId };
      }

      if (reservation.status !== 'PENDING' || new Date() >= new Date(reservation.expires_at)) {
        const isExpired = reservation.status === 'EXPIRED' || new Date() >= new Date(reservation.expires_at);
        const reason = isExpired ? 'RESERVATION_EXPIRED' : `RESERVATION_ALREADY_${reservation.status}`;

        await client.query('ROLLBACK');

        // Post-expiry payment handling: Trigger immediate provider refund
        try {
          await this.provider.processRefund({
            paymentId,
            providerPaymentId,
            amountMinor,
            reason: `Post-expiry automatic refund: ${reason}`,
          });
        } catch (rfdErr) {
          logger.warn(`Automatic refund error for expired reservation ${reservationId}:`, rfdErr);
        }

        throw new Error(reason);
      }

      const sessionId = reservation.event_session_id;

      // 2. Insert Confirmed Booking
      await client.query(
        `INSERT INTO bookings (
          id, reservation_id, user_id, event_session_id, status, total_amount_minor, currency, confirmed_at
        ) VALUES ($1, $2, $3, $4, 'CONFIRMED', $5, $6, CURRENT_TIMESTAMP);`,
        [bookingId, reservationId, userId, sessionId, amountMinor, currency]
      );

      // 3. Snapshot Booking Items from Reservation Items
      await client.query(
        `INSERT INTO booking_items (booking_id, event_session_id, session_seat_id, unit_price_minor)
         SELECT $1, event_session_id, session_seat_id, unit_price_minor
         FROM reservation_items
         WHERE reservation_id = $2;`,
        [bookingId, reservationId]
      );

      // 4. Insert Payment Record
      await client.query(
        `INSERT INTO payments (
          id, booking_id, user_id, amount_minor, currency, provider, provider_payment_id, idempotency_key, status
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'SUCCEEDED');`,
        [
          paymentId,
          bookingId,
          userId,
          amountMinor,
          currency,
          this.provider.providerName,
          providerPaymentId,
          idempotencyKey,
        ]
      );

      // 5. Update Reservation status to CONFIRMED
      await client.query(
        `UPDATE reservations
         SET status = 'CONFIRMED', updated_at = CURRENT_TIMESTAMP
         WHERE id = $1;`,
        [reservationId]
      );

      // 6. Update Session Seats to BOOKED
      await client.query(
        `UPDATE session_seats
         SET status = 'BOOKED',
             current_booking_id = $1,
             current_reservation_id = NULL,
             hold_expires_at = NULL,
             updated_at = CURRENT_TIMESTAMP
         WHERE current_reservation_id = $2 AND event_session_id = $3;`,
        [bookingId, reservationId, sessionId]
      );

      // 7. Append Immutable Transaction Ledger entry (Financial Audit Trail)
      const ledgerReference = `REF-CHG-${providerPaymentId}`;
      await client.query(
        `INSERT INTO transaction_ledger (
          payment_id, booking_id, transaction_type, amount_minor, currency, reference
        ) VALUES ($1, $2, 'CHARGE', $3, $4, $5);`,
        [paymentId, bookingId, amountMinor, currency, ledgerReference]
      );

      await client.query('COMMIT');
      logger.info(`Durable booking ${bookingId} and payment ${paymentId} committed to database.`);
    } catch (dbErr) {
      await client.query('ROLLBACK');
      throw dbErr;
    } finally {
      client.release();
    }

    // 8. Confirm in Redis inventory engine
    try {
      const resData = await dbPool.query('SELECT event_session_id FROM reservations WHERE id = $1;', [
        reservationId,
      ]);
      const sessId = resData.rows[0].event_session_id;

      await this.inventoryService.confirmSeats({
        sessionId: sessId,
        reservationId,
        userId,
      });
      logger.info(`Redis inventory confirmed as BOOKED for reservation ${reservationId}`);
    } catch (redisErr) {
      logger.warn(`Redis confirmation notice for reservation ${reservationId}:`, redisErr);
    }

    metrics.increment('payment_success_total');
    return { bookingId, paymentId };
  }

  /**
   * Handle payment failure:
   * Sets reservation status to FAILED and releases Redis hold immediately.
   */
  async handlePaymentFailure(params: {
    reservationId: string;
    userId: string;
    failureReason: string;
  }): Promise<void> {
    const { reservationId, userId, failureReason } = params;

    const resQuery = await dbPool.query(
      `SELECT event_session_id FROM reservations WHERE id = $1;`,
      [reservationId]
    );

    if (resQuery.rows.length === 0) return;
    const sessionId = resQuery.rows[0].event_session_id;

    // Update reservation status in database
    await dbPool.query(
      `UPDATE reservations
       SET status = 'FAILED', updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND status = 'PENDING';`,
      [reservationId]
    );

    // Release held inventory in Redis immediately
    try {
      await this.inventoryService.releaseSeats({
        sessionId,
        reservationId,
        userId,
        reason: 'CANCELLED',
      });
      logger.info(`Released Redis inventory due to payment failure for reservation ${reservationId}: ${failureReason}`);
    } catch (err) {
      logger.warn('Error releasing Redis inventory on payment failure:', err);
    }

    metrics.increment('payment_failure_total');
  }

  /**
   * Process a refund for an existing confirmed booking.
   * Updates booking status to REFUNDED and inserts immutable REFUND ledger entry.
   */
  async processBookingRefund(params: {
    bookingId: string;
    userId: string;
    reason?: string;
  }): Promise<{ refundId: string }> {
    const { bookingId, userId, reason } = params;

    const client = await dbPool.connect();
    try {
      await client.query('BEGIN');

      // Fetch and lock booking
      const bRes = await client.query(
        `SELECT b.id, b.user_id, b.status, b.total_amount_minor, b.currency,
                p.id as payment_id, p.provider_payment_id
         FROM bookings b
         JOIN payments p ON p.booking_id = b.id
         WHERE b.id = $1
         FOR UPDATE;`,
        [bookingId]
      );

      if (bRes.rows.length === 0) {
        throw new Error('BOOKING_NOT_FOUND');
      }

      const booking = bRes.rows[0];
      if (booking.user_id !== userId) {
        throw new Error('FORBIDDEN_BOOKING');
      }

      if (booking.status === 'REFUNDED') {
        const existingLedger = await client.query(
          `SELECT reference FROM transaction_ledger WHERE booking_id = $1 AND transaction_type = 'REFUND' ORDER BY created_at DESC LIMIT 1;`,
          [bookingId]
        );
        const refId = existingLedger.rows[0]?.reference?.replace(/^REF-RFD-/, '') || 'already_refunded';
        await client.query('COMMIT');
        return { refundId: refId };
      }

      // 1. Call payment provider refund
      const refundResult = await this.provider.processRefund({
        paymentId: booking.payment_id,
        providerPaymentId: booking.provider_payment_id,
        amountMinor: Number(booking.total_amount_minor),
        reason,
      });

      if (!refundResult.success) {
        throw new Error('PROVIDER_REFUND_FAILED');
      }

      // 2. Update booking and payment statuses in DB
      await client.query(
        `UPDATE bookings SET status = 'REFUNDED', updated_at = CURRENT_TIMESTAMP WHERE id = $1;`,
        [bookingId]
      );

      await client.query(
        `UPDATE payments SET status = 'REFUNDED', updated_at = CURRENT_TIMESTAMP WHERE id = $1;`,
        [booking.payment_id]
      );

      // 3. Append Immutable Ledger Entry
      const ledgerRef = `REF-RFD-${refundResult.refundId}`;
      await client.query(
        `INSERT INTO transaction_ledger (
          payment_id, booking_id, transaction_type, amount_minor, currency, reference
        ) VALUES ($1, $2, 'REFUND', $3, $4, $5);`,
        [booking.payment_id, bookingId, Number(booking.total_amount_minor), booking.currency, ledgerRef]
      );

      await client.query('COMMIT');
      metrics.increment('booking_refund_total');
      return { refundId: refundResult.refundId };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}
