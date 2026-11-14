import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { dbPool } from '../config/database.js';
import { requireAuth } from '../middleware/auth.js';
import { PaymentService } from '../services/payment/payment.service.js';
import { logger } from '../utils/logger.js';

export const bookingsRouter = Router();

const paymentService = new PaymentService();
const uuidParamSchema = z.string().uuid({ message: 'Invalid UUID identifier' });

const refundBodySchema = z.object({
  reason: z.string().max(255).optional(),
});

/**
 * GET /api/v1/bookings
 * Returns user's bookings (or all if admin).
 */
bookingsRouter.get('/bookings', requireAuth, async (req: Request, res: Response) => {
  const userId = req.user!.id;
  const isAdmin = req.user!.role === 'admin';
  const targetUserId = isAdmin && typeof req.query.userId === 'string' ? req.query.userId : userId;

  try {
    const query = isAdmin && !req.query.userId
      ? `SELECT b.id, b.reservation_id, b.user_id, b.event_session_id, b.status, 
                b.total_amount_minor, b.currency, b.confirmed_at, b.created_at,
                e.title as event_title, e.id as event_id,
                es.starts_at, es.ends_at, v.name as venue_name, v.city as venue_city,
                COUNT(bi.id) as item_count
         FROM bookings b
         JOIN event_sessions es ON es.id = b.event_session_id
         JOIN events e ON e.id = es.event_id
         JOIN venues v ON v.id = es.venue_id
         LEFT JOIN booking_items bi ON bi.booking_id = b.id
         GROUP BY b.id, e.id, es.id, v.id
         ORDER BY b.created_at DESC;`
      : `SELECT b.id, b.reservation_id, b.user_id, b.event_session_id, b.status, 
                b.total_amount_minor, b.currency, b.confirmed_at, b.created_at,
                e.title as event_title, e.id as event_id,
                es.starts_at, es.ends_at, v.name as venue_name, v.city as venue_city,
                COUNT(bi.id) as item_count
         FROM bookings b
         JOIN event_sessions es ON es.id = b.event_session_id
         JOIN events e ON e.id = es.event_id
         JOIN venues v ON v.id = es.venue_id
         LEFT JOIN booking_items bi ON bi.booking_id = b.id
         WHERE b.user_id = $1
         GROUP BY b.id, e.id, es.id, v.id
         ORDER BY b.created_at DESC;`;

    const params = isAdmin && !req.query.userId ? [] : [targetUserId];
    const result = await dbPool.query(query, params);

    const bookings = result.rows.map((row) => ({
      id: row.id,
      reservationId: row.reservation_id,
      userId: row.user_id,
      status: row.status,
      totalAmountMinor: Number(row.total_amount_minor),
      currency: row.currency,
      confirmedAt: row.confirmed_at,
      createdAt: row.created_at,
      itemCount: Number(row.item_count || 0),
      event: {
        id: row.event_id,
        title: row.event_title,
        startsAt: row.starts_at,
        endsAt: row.ends_at,
        venueName: row.venue_name,
        venueCity: row.venue_city,
      },
    }));

    res.status(200).json({
      success: true,
      data: bookings,
      timestamp: new Date().toISOString(),
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('Error fetching bookings:', msg);
    res.status(500).json({
      success: false,
      error: { code: 'DATABASE_ERROR', message: 'Failed to retrieve bookings' },
      timestamp: new Date().toISOString(),
    });
  }
});

/**
 * GET /api/v1/bookings/:bookingId
 * Returns complete details for a booking including seat items and payment.
 */
bookingsRouter.get('/bookings/:bookingId', requireAuth, async (req: Request, res: Response) => {
  const paramResult = uuidParamSchema.safeParse(req.params.bookingId);
  if (!paramResult.success) {
    res.status(400).json({
      success: false,
      error: { code: 'INVALID_BOOKING_ID', message: 'Invalid booking ID parameter format' },
      timestamp: new Date().toISOString(),
    });
    return;
  }

  const bookingId = paramResult.data;
  const userId = req.user!.id;
  const isAdmin = req.user!.role === 'admin';

  try {
    const bookingRes = await dbPool.query(
      `SELECT b.id, b.reservation_id, b.user_id, b.event_session_id, b.status, 
              b.total_amount_minor, b.currency, b.confirmed_at, b.created_at,
              e.id as event_id, e.title as event_title, e.description as event_description,
              es.id as session_id, es.starts_at, es.ends_at,
              v.name as venue_name, v.address as venue_address, v.city as venue_city
       FROM bookings b
       JOIN event_sessions es ON es.id = b.event_session_id
       JOIN events e ON e.id = es.event_id
       JOIN venues v ON v.id = es.venue_id
       WHERE b.id = $1;`,
      [bookingId]
    );

    if (bookingRes.rows.length === 0) {
      res.status(404).json({
        success: false,
        error: { code: 'BOOKING_NOT_FOUND', message: 'Booking not found' },
        timestamp: new Date().toISOString(),
      });
      return;
    }

    const row = bookingRes.rows[0];
    if (row.user_id !== userId && !isAdmin) {
      res.status(403).json({
        success: false,
        error: { code: 'FORBIDDEN', message: 'Not authorized to view this booking' },
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Fetch booking items with seat info
    const itemsRes = await dbPool.query(
      `SELECT bi.id, bi.session_seat_id, bi.unit_price_minor,
              vs.section, vs.row_label, vs.seat_number, vs.seat_type
       FROM booking_items bi
       JOIN session_seats ss ON ss.id = bi.session_seat_id
       JOIN venue_seats vs ON vs.id = ss.venue_seat_id
       WHERE bi.booking_id = $1
       ORDER BY vs.section, vs.row_label, vs.seat_number;`,
      [bookingId]
    );

    // Fetch payment record
    const paymentRes = await dbPool.query(
      `SELECT id, provider, provider_payment_id, status, amount_minor, currency, created_at
       FROM payments
       WHERE booking_id = $1
       ORDER BY created_at DESC
       LIMIT 1;`,
      [bookingId]
    );

    const booking = {
      id: row.id,
      reservationId: row.reservation_id,
      userId: row.user_id,
      status: row.status,
      totalAmountMinor: Number(row.total_amount_minor),
      currency: row.currency,
      confirmedAt: row.confirmed_at,
      createdAt: row.created_at,
      event: {
        id: row.event_id,
        title: row.event_title,
        description: row.event_description,
      },
      session: {
        id: row.session_id,
        startsAt: row.starts_at,
        endsAt: row.ends_at,
        venueName: row.venue_name,
        venueAddress: row.venue_address,
        venueCity: row.venue_city,
      },
      items: itemsRes.rows.map((item) => ({
        id: item.id,
        sessionSeatId: item.session_seat_id,
        unitPriceMinor: Number(item.unit_price_minor),
        section: item.section,
        rowLabel: item.row_label,
        seatNumber: item.seat_number,
        seatType: item.seat_type,
      })),
      payment: paymentRes.rows.length > 0 ? {
        id: paymentRes.rows[0].id,
        provider: paymentRes.rows[0].provider,
        providerPaymentId: paymentRes.rows[0].provider_payment_id,
        status: paymentRes.rows[0].status,
        amountMinor: Number(paymentRes.rows[0].amount_minor),
        currency: paymentRes.rows[0].currency,
        createdAt: paymentRes.rows[0].created_at,
      } : null,
    };

    res.status(200).json({
      success: true,
      data: booking,
      timestamp: new Date().toISOString(),
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`Error fetching booking ${bookingId}:`, msg);
    res.status(500).json({
      success: false,
      error: { code: 'DATABASE_ERROR', message: 'Failed to retrieve booking details' },
      timestamp: new Date().toISOString(),
    });
  }
});

/**
 * POST /api/v1/bookings/:bookingId/refund
 * Initiates a refund for a confirmed booking.
 */
bookingsRouter.post('/bookings/:bookingId/refund', requireAuth, async (req: Request, res: Response) => {
  const paramResult = uuidParamSchema.safeParse(req.params.bookingId);
  if (!paramResult.success) {
    res.status(400).json({
      success: false,
      error: { code: 'INVALID_BOOKING_ID', message: 'Invalid booking ID parameter format' },
      timestamp: new Date().toISOString(),
    });
    return;
  }

  const bookingId = paramResult.data;
  const userId = req.user!.id;
  const bodyResult = refundBodySchema.safeParse(req.body);
  const reason = bodyResult.success ? bodyResult.data.reason : undefined;

  try {
    const result = await paymentService.processBookingRefund({
      bookingId,
      userId,
      reason,
    });

    res.status(200).json({
      success: true,
      data: {
        bookingId,
        refundId: result.refundId,
        status: 'REFUNDED',
      },
      timestamp: new Date().toISOString(),
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`Refund failed for booking ${bookingId}:`, msg);

    if (msg === 'BOOKING_NOT_FOUND') {
      res.status(404).json({
        success: false,
        error: { code: 'BOOKING_NOT_FOUND', message: 'Booking not found' },
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (msg === 'FORBIDDEN_BOOKING') {
      res.status(403).json({
        success: false,
        error: { code: 'FORBIDDEN', message: 'Not authorized to refund this booking' },
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (msg === 'BOOKING_ALREADY_REFUNDED') {
      res.status(409).json({
        success: false,
        error: { code: 'ALREADY_REFUNDED', message: 'Booking is already refunded' },
        timestamp: new Date().toISOString(),
      });
      return;
    }

    res.status(500).json({
      success: false,
      error: { code: 'REFUND_ERROR', message: msg },
      timestamp: new Date().toISOString(),
    });
  }
});
