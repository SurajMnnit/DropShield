import crypto from 'crypto';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { dbPool } from '../src/config/database.js';
import { DevPaymentProvider } from '../src/services/payment/dev-payment.provider.js';
import { PaymentService } from '../src/services/payment/payment.service.js';

describe('Phase 7: Payment Consistency & Webhook Idempotency Test Suite', () => {
  const app = createApp();
  const paymentService = new PaymentService(new DevPaymentProvider());

  const userId = crypto.randomUUID();
  const venueId = crypto.randomUUID();
  const eventId = crypto.randomUUID();
  const sessionId = crypto.randomUUID();
  const venueSeatId1 = crypto.randomUUID();
  const venueSeatId2 = crypto.randomUUID();
  const sessionSeatId1 = crypto.randomUUID();
  const sessionSeatId2 = crypto.randomUUID();

  beforeAll(async () => {
    // 1. Create User
    await dbPool.query(
      `INSERT INTO users (id, name, email, password_hash, role)
       VALUES ($1, 'Payment Consistency User', $2, 'hashed_pw', 'buyer');`,
      [userId, `pay_consist.${Date.now()}@example.com`]
    );

    // 2. Create Venue & Seats
    await dbPool.query(
      `INSERT INTO venues (id, name, address, city, state, country)
       VALUES ($1, 'Financial Consistency Arena', '400 Ledger Row', 'Bengaluru', 'KA', 'India');`,
      [venueId]
    );

    await dbPool.query(
      `INSERT INTO venue_seats (id, venue_id, section, row_label, seat_number, seat_type)
       VALUES 
        ($1, $2, 'A', '1', '1', 'Standard'),
        ($3, $2, 'A', '1', '2', 'Standard');`,
      [venueSeatId1, venueId, venueSeatId2]
    );

    // 3. Create Event & Session
    await dbPool.query(
      `INSERT INTO events (id, title, description, category, status)
       VALUES ($1, 'Ledger Integrity Concert', 'Financial Audit Protection', 'Music', 'PUBLISHED');`,
      [eventId]
    );

    const startsAt = new Date(Date.now() + 86400000);
    const endsAt = new Date(Date.now() + 90000000);
    await dbPool.query(
      `INSERT INTO event_sessions (id, event_id, venue_id, starts_at, ends_at, status)
       VALUES ($1, $2, $3, $4, $5, 'OPEN');`,
      [sessionId, eventId, venueId, startsAt, endsAt]
    );

    // 4. Create Session Seats
    await dbPool.query(
      `INSERT INTO session_seats (id, event_session_id, venue_id, venue_seat_id, status, price_minor)
       VALUES 
        ($1, $2, $3, $4, 'AVAILABLE', 60000),
        ($5, $2, $3, $6, 'AVAILABLE', 60000);`,
      [sessionSeatId1, sessionId, venueId, venueSeatId1, sessionSeatId2, venueSeatId2]
    );
  });

  it('handles duplicate webhook delivery idempotently without creating duplicate bookings or ledger rows', async () => {
    const reservationId = crypto.randomUUID();
    const providerPaymentId = `mock_pay_idemp_${crypto.randomUUID()}`;
    const futureExpiresAt = new Date(Date.now() + 600000);

    // Seed reservation in PENDING state
    await dbPool.query(
      `INSERT INTO reservations (id, user_id, event_session_id, status, expires_at, total_amount_minor, currency, idempotency_key)
       VALUES ($1, $2, $3, 'PENDING', $4, 60000, 'INR', $5);`,
      [reservationId, userId, sessionId, futureExpiresAt, `idemp_webhook_${Date.now()}`]
    );

    await dbPool.query(
      `INSERT INTO reservation_items (reservation_id, event_session_id, session_seat_id, unit_price_minor)
       VALUES ($1, $2, $3, 60000);`,
      [reservationId, sessionId, sessionSeatId1]
    );

    await dbPool.query(
      `UPDATE session_seats
       SET status = 'HELD', current_reservation_id = $1, hold_expires_at = $2
       WHERE id = $3;`,
      [reservationId, futureExpiresAt, sessionSeatId1]
    );

    const webhookBody = {
      event: 'payment.succeeded',
      data: {
        reservationId,
        userId,
        providerPaymentId,
        amountMinor: 60000,
        currency: 'INR',
      },
    };

    const rawBody = JSON.stringify(webhookBody);
    const signature = DevPaymentProvider.signPayload(rawBody);

    // Delivery 1
    const res1 = await request(app)
      .post('/api/v1/payments/webhook')
      .set('x-dropshield-signature', signature)
      .set('Content-Type', 'application/json')
      .send(rawBody);

    expect(res1.status).toBe(200);

    // Delivery 2 (duplicate delivery from payment provider)
    const res2 = await request(app)
      .post('/api/v1/payments/webhook')
      .set('x-dropshield-signature', signature)
      .set('Content-Type', 'application/json')
      .send(rawBody);

    expect(res2.status).toBe(200);

    // Verify exactly ONE booking was created
    const bookingCheck = await dbPool.query(
      `SELECT id FROM bookings WHERE reservation_id = $1;`,
      [reservationId]
    );
    expect(bookingCheck.rows.length).toBe(1);

    // Verify exactly ONE ledger record was created
    const ledgerCheck = await dbPool.query(
      `SELECT id FROM transaction_ledger WHERE booking_id = $1;`,
      [bookingCheck.rows[0].id]
    );
    expect(ledgerCheck.rows.length).toBe(1);
  });

  it('safely handles post-expiry payment webhook delivery and triggers automatic refund', async () => {
    const expiredResId = crypto.randomUUID();
    const providerPaymentId = `mock_pay_exp_${crypto.randomUUID()}`;
    const pastExpiresAt = new Date(Date.now() - 60000); // 1 minute ago

    // Seed expired reservation
    await dbPool.query(
      `INSERT INTO reservations (id, user_id, event_session_id, status, expires_at, total_amount_minor, currency, idempotency_key)
       VALUES ($1, $2, $3, 'EXPIRED', $4, 60000, 'INR', $5);`,
      [expiredResId, userId, sessionId, pastExpiresAt, `idemp_webhook_exp_${Date.now()}`]
    );

    const webhookBody = {
      event: 'payment.succeeded',
      data: {
        reservationId: expiredResId,
        userId,
        providerPaymentId,
        amountMinor: 60000,
        currency: 'INR',
      },
    };

    const rawBody = JSON.stringify(webhookBody);
    const signature = DevPaymentProvider.signPayload(rawBody);

    const res = await request(app)
      .post('/api/v1/payments/webhook')
      .set('x-dropshield-signature', signature)
      .set('Content-Type', 'application/json')
      .send(rawBody);

    // Should gracefully respond 200 with EXPIRED_AND_REFUNDED outcome
    expect(res.status).toBe(200);
    expect(res.body.received).toBe(true);
    expect(res.body.outcome).toBe('EXPIRED_AND_REFUNDED');

    // No confirmed booking created
    const bookingCheck = await dbPool.query(
      `SELECT id FROM bookings WHERE reservation_id = $1;`,
      [expiredResId]
    );
    expect(bookingCheck.rows.length).toBe(0);

    // No unlinked payment was committed
    const paymentCheck = await dbPool.query(
      `SELECT status FROM payments WHERE provider_payment_id = $1;`,
      [providerPaymentId]
    );
    expect(paymentCheck.rows.length).toBe(0);
  });

  it('executes idempotent refunds returning existing refund reference without duplicate ledger entries', async () => {
    const refundResId = crypto.randomUUID();
    const futureExpiresAt = new Date(Date.now() + 600000);

    // Create reservation, booking, and payment
    await dbPool.query(
      `INSERT INTO reservations (id, user_id, event_session_id, status, expires_at, total_amount_minor, currency, idempotency_key)
       VALUES ($1, $2, $3, 'PENDING', $4, 60000, 'INR', $5);`,
      [refundResId, userId, sessionId, futureExpiresAt, `idemp_ref_${Date.now()}`]
    );

    await dbPool.query(
      `INSERT INTO reservation_items (reservation_id, event_session_id, session_seat_id, unit_price_minor)
       VALUES ($1, $2, $3, 60000);`,
      [refundResId, sessionId, sessionSeatId2]
    );

    await dbPool.query(
      `UPDATE session_seats
       SET status = 'HELD', current_reservation_id = $1, hold_expires_at = $2
       WHERE id = $3;`,
      [refundResId, futureExpiresAt, sessionSeatId2]
    );

    const provPaymentId = `mock_pay_to_refund_${crypto.randomUUID()}`;
    const finalized = await paymentService.finalizePaymentSuccess({
      reservationId: refundResId,
      userId,
      providerPaymentId: provPaymentId,
      amountMinor: 60000,
      currency: 'INR',
    });

    // 1. Execute initial refund
    const refund1 = await paymentService.processBookingRefund({
      bookingId: finalized.bookingId,
      userId,
      reason: 'User cancelled plan',
    });
    expect(refund1.refundId).toBeDefined();

    // 2. Execute duplicate refund request for the same booking
    const refund2 = await paymentService.processBookingRefund({
      bookingId: finalized.bookingId,
      userId,
      reason: 'User cancelled plan (repeat)',
    });
    expect(refund2.refundId).toBe(refund1.refundId);

    // 3. Verify exactly ONE REFUND entry in transaction_ledger
    const ledgerRefunds = await dbPool.query(
      `SELECT id FROM transaction_ledger WHERE booking_id = $1 AND transaction_type = 'REFUND';`,
      [finalized.bookingId]
    );
    expect(ledgerRefunds.rows.length).toBe(1);
  });
});
