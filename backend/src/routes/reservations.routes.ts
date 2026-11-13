import { Router } from 'express';
import type { Request, Response } from 'express';
import crypto from 'crypto';
import { z } from 'zod';
import { dbPool } from '../config/database.js';
import { requireAuth } from '../middleware/auth.js';
import { RedisInventoryService } from '../services/inventory.service.js';
import { TransactionalOutboxService } from '../services/outbox.service.js';
import { logger } from '../utils/logger.js';
import { metrics } from '../utils/metrics.js';

export const reservationsRouter = Router();

const inventoryService = new RedisInventoryService();
const outboxService = new TransactionalOutboxService();

const holdRequestSchema = z.object({
  seatIds: z
    .array(z.string().uuid({ message: 'Each seatId must be a valid UUID' }))
    .min(1, { message: 'At least one seat must be selected' })
    .max(10, { message: 'Maximum 10 seats allowed per reservation' }),
});

const uuidParamSchema = z.string().uuid({ message: 'Invalid UUID identifier' });

/**
 * POST /api/v1/sessions/:sessionId/reservations
 * Asynchronously intake reservation request:
 * 1. Validate payload and headers
 * 2. Atomic Redis seat hold
 * 3. PostgreSQL transaction (reservation + items + session_seats + outbox event)
 * 4. Automatic compensation release in Redis if DB transaction fails
 * 5. Return HTTP 202 Accepted
 */
reservationsRouter.post('/sessions/:sessionId/reservations', requireAuth, async (req: Request, res: Response) => {
  const startTime = Date.now();
  metrics.increment('api_booking_requests_total');

  const sessionParamResult = uuidParamSchema.safeParse(req.params.sessionId);
  if (!sessionParamResult.success) {
    res.status(400).json({
      success: false,
      error: {
        code: 'INVALID_SESSION_ID',
        message: 'Invalid session ID parameter format',
        details: sessionParamResult.error.format(),
      },
      timestamp: new Date().toISOString(),
    });
    return;
  }
  const sessionId = sessionParamResult.data;

  // Header or body idempotency key (header is authoritative)
  const headerIdempotencyKey = req.header('x-idempotency-key') || req.body?.idempotencyKey;
  if (!headerIdempotencyKey || typeof headerIdempotencyKey !== 'string' || headerIdempotencyKey.trim().length < 8) {
    res.status(400).json({
      success: false,
      error: {
        code: 'MISSING_IDEMPOTENCY_KEY',
        message: 'A valid X-Idempotency-Key header (min 8 characters) is required',
      },
      timestamp: new Date().toISOString(),
    });
    return;
  }
  const idempotencyKey = headerIdempotencyKey.trim();

  // Validate request body
  const bodyResult = holdRequestSchema.safeParse(req.body);
  if (!bodyResult.success) {
    res.status(400).json({
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Invalid reservation request payload',
        details: bodyResult.error.format(),
      },
      timestamp: new Date().toISOString(),
    });
    return;
  }

  const { seatIds } = bodyResult.data;
  const userId = req.user!.id;

  // Reject duplicates within request
  const uniqueSeatCount = new Set(seatIds).size;
  if (uniqueSeatCount !== seatIds.length) {
    res.status(400).json({
      success: false,
      error: {
        code: 'DUPLICATE_SEATS',
        message: 'Duplicate seat IDs specified within the reservation request',
      },
      timestamp: new Date().toISOString(),
    });
    return;
  }

  // 1. Check existing database idempotency record
  try {
    const existingIdemp = await dbPool.query(
      `SELECT status, response_status, response_body 
       FROM idempotency_records 
       WHERE user_id = $1 AND operation = 'RESERVATION_HOLD' AND idempotency_key = $2;`,
      [userId, idempotencyKey]
    );

    if (existingIdemp.rows.length > 0) {
      const record = existingIdemp.rows[0];
      if (record.status === 'COMPLETED' && record.response_body) {
        metrics.increment('api_booking_replayed_total');
        res.status(record.response_status || 202).json(record.response_body);
        return;
      }
      if (record.status === 'IN_PROGRESS') {
        res.status(409).json({
          success: false,
          error: {
            code: 'CONCURRENT_REQUEST',
            message: 'A reservation request with this idempotency key is already in progress',
          },
          timestamp: new Date().toISOString(),
        });
        return;
      }
    }
  } catch (err: unknown) {
    logger.warn('Failed to query idempotency record:', err);
  }

  const reservationId = crypto.randomUUID();
  const holdTtlSeconds = 600; // 10 minutes lease

  // 2. Perform Atomic Redis Seat Hold
  let holdResult;
  try {
    holdResult = await inventoryService.holdSeats({
      sessionId,
      userId,
      reservationId,
      seatIds,
      idempotencyKey,
      holdTtlSeconds,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    metrics.increment('redis_hold_failure_total');
    logger.error('Redis atomic seat hold unexpected failure:', msg);
    res.status(500).json({
      success: false,
      error: {
        code: 'INVENTORY_HOLD_FAILED',
        message: 'Failed to acquire in-memory inventory lease. Please retry.',
      },
      timestamp: new Date().toISOString(),
    });
    return;
  }

  if (!holdResult.success) {
    metrics.increment('redis_hold_rejected_total');
    if (holdResult.error === 'SEAT_UNAVAILABLE') {
      res.status(409).json({
        success: false,
        error: {
          code: 'SEAT_UNAVAILABLE',
          message: 'One or more requested seats are no longer available',
          details: { seatId: holdResult.seatId },
        },
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (holdResult.error === 'SEAT_NOT_FOUND') {
      res.status(404).json({
        success: false,
        error: {
          code: 'SEAT_NOT_FOUND',
          message: 'One or more requested seats do not exist in the session',
          details: { seatId: holdResult.seatId },
        },
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (holdResult.error === 'IDEMPOTENCY_CONFLICT') {
      res.status(409).json({
        success: false,
        error: {
          code: 'IDEMPOTENCY_CONFLICT',
          message: 'This idempotency key has already been used with different reservation parameters',
        },
        timestamp: new Date().toISOString(),
      });
      return;
    }

    res.status(400).json({
      success: false,
      error: {
        code: holdResult.error || 'HOLD_FAILED',
        message: 'Could not complete seat reservation hold',
      },
      timestamp: new Date().toISOString(),
    });
    return;
  }

  metrics.increment('redis_hold_success_total');

  // 3. PostgreSQL Transaction: Commit Reservation + Outbox Event Together
  const expiresAt = new Date(holdResult.expiresAt || Date.now() + holdTtlSeconds * 1000);
  const acceptedAt = new Date().toISOString();
  const statusUrl = `/api/v1/reservations/${reservationId}`;

  const responsePayload = {
    success: true,
    data: {
      reservationId,
      status: 'PENDING',
      sessionId,
      seatIds,
      expiresAt: expiresAt.toISOString(),
      acceptedAt,
      statusUrl,
    },
    timestamp: acceptedAt,
  };

  const client = await dbPool.connect();

  try {
    await client.query('BEGIN');

    // Query session seats in database to calculate total price and ensure session integrity
    const seatsRes = await client.query(
      `SELECT id, price_minor, status FROM session_seats 
       WHERE event_session_id = $1 AND id = ANY($2);`,
      [sessionId, seatIds]
    );

    let totalPriceMinor = 0;
    if (seatsRes.rows.length > 0) {
      totalPriceMinor = seatsRes.rows.reduce(
        (sum: number, row: { price_minor: string | number }) => sum + Number(row.price_minor || 0),
        0
      );
    }

    // Insert Reservation Record
    await client.query(
      `INSERT INTO reservations (
        id, user_id, event_session_id, status, expires_at, total_amount_minor, currency, idempotency_key
      ) VALUES ($1, $2, $3, 'PENDING', $4, $5, 'INR', $6);`,
      [reservationId, userId, sessionId, expiresAt, totalPriceMinor, idempotencyKey]
    );

    // Insert Reservation Items
    for (const seatId of seatIds) {
      const seatRow = seatsRes.rows.find((s: { id: string }) => s.id === seatId);
      const unitPrice = seatRow ? Number(seatRow.price_minor || 0) : 0;
      await client.query(
        `INSERT INTO reservation_items (
          reservation_id, event_session_id, session_seat_id, unit_price_minor
        ) VALUES ($1, $2, $3, $4);`,
        [reservationId, sessionId, seatId, unitPrice]
      );
    }

    // Update Session Seats State to HELD
    await client.query(
      `UPDATE session_seats
       SET status = 'HELD',
           current_reservation_id = $1,
           hold_expires_at = $2,
           updated_at = CURRENT_TIMESTAMP
       WHERE event_session_id = $3 AND id = ANY($4);`,
      [reservationId, expiresAt, sessionId, seatIds]
    );

    // Insert Transactional Outbox Event
    await outboxService.createOutboxEvent(client, {
      aggregateType: 'RESERVATION',
      aggregateId: reservationId,
      eventType: 'booking.requested',
      payload: {
        reservationId,
        sessionId,
        userId,
        seatIds,
        idempotencyKey,
        expiresAt: expiresAt.toISOString(),
        totalAmountMinor: totalPriceMinor,
        currency: 'INR',
      },
    });

    // Record Idempotency Record
    const requestHash = crypto
      .createHash('sha256')
      .update(JSON.stringify({ sessionId, seatIds }))
      .digest('hex');

    await client.query(
      `INSERT INTO idempotency_records (
        user_id, idempotency_key, operation, request_hash, response_status, response_body, status, expires_at
      ) VALUES ($1, $2, 'RESERVATION_HOLD', $3, 202, $4, 'COMPLETED', $5)
      ON CONFLICT (user_id, operation, idempotency_key)
      DO UPDATE SET 
        response_status = EXCLUDED.response_status,
        response_body = EXCLUDED.response_body,
        status = 'COMPLETED',
        updated_at = CURRENT_TIMESTAMP;`,
      [userId, idempotencyKey, requestHash, JSON.stringify(responsePayload), expiresAt]
    );

    await client.query('COMMIT');
    metrics.increment('db_reservation_commit_success_total');
  } catch (err: unknown) {
    await client.query('ROLLBACK');
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.error(`Database transaction failed for reservation ${reservationId}:`, errMsg);

    metrics.increment('db_reservation_commit_failure_total');

    // 4. Safe Compensation: Release held seats in Redis
    try {
      await inventoryService.releaseSeats({
        sessionId,
        reservationId,
        userId,
        reason: 'COMPENSATION_ROLLBACK',
      });
      logger.info(`Redis inventory compensation succeeded for reservation: ${reservationId}`);
      metrics.increment('redis_compensation_success_total');
    } catch (compErr: unknown) {
      const compMsg = compErr instanceof Error ? compErr.message : String(compErr);
      logger.error(`CRITICAL: Redis inventory compensation failed for reservation ${reservationId}:`, compMsg);
      metrics.increment('redis_compensation_critical_failure_total');
    }

    res.status(500).json({
      success: false,
      error: {
        code: 'PERSISTENCE_ERROR',
        message: 'Failed to persist reservation transaction. Inventory hold was rolled back.',
      },
      timestamp: new Date().toISOString(),
    });
    return;
  } finally {
    client.release();
  }

  // 5. Asynchronously trigger immediate outbox processing (non-blocking)
  outboxService.processBatch(5).catch((err) => {
    logger.warn('Asynchronous outbox background push notice:', err);
  });

  const durationMs = Date.now() - startTime;
  logger.info(`Accepted reservation ${reservationId} for session ${sessionId} [${durationMs}ms]`);
  metrics.recordTiming('api_reservation_intake_duration_ms', durationMs);

  // Return HTTP 202 Accepted
  res.status(202).json(responsePayload);
});

/**
 * GET /api/v1/reservations/:reservationId
 * Returns durable booking and reservation status from PostgreSQL.
 */
reservationsRouter.get('/reservations/:reservationId', requireAuth, async (req: Request, res: Response) => {
  const paramResult = uuidParamSchema.safeParse(req.params.reservationId);
  if (!paramResult.success) {
    res.status(400).json({
      success: false,
      error: {
        code: 'INVALID_RESERVATION_ID',
        message: 'Invalid reservation ID parameter format',
      },
      timestamp: new Date().toISOString(),
    });
    return;
  }
  const reservationId = paramResult.data;
  const userId = req.user!.id;

  try {
    const queryRes = await dbPool.query(
      `SELECT r.id, r.user_id, r.event_session_id, r.status, r.expires_at, 
              r.total_amount_minor, r.currency, r.created_at, r.updated_at,
              b.id as booking_id, b.status as booking_status, b.confirmed_at
       FROM reservations r
       LEFT JOIN bookings b ON b.reservation_id = r.id
       WHERE r.id = $1;`,
      [reservationId]
    );

    if (queryRes.rows.length === 0) {
      res.status(404).json({
        success: false,
        error: {
          code: 'RESERVATION_NOT_FOUND',
          message: 'Reservation record not found',
        },
        timestamp: new Date().toISOString(),
      });
      return;
    }

    const reservation = queryRes.rows[0];

    // Ownership check: Users can only inspect their own reservations (unless admin)
    if (reservation.user_id !== userId && req.user!.role !== 'admin') {
      res.status(403).json({
        success: false,
        error: {
          code: 'FORBIDDEN',
          message: 'You are not authorized to inspect this reservation',
        },
        timestamp: new Date().toISOString(),
      });
      return;
    }

    res.status(200).json({
      success: true,
      data: {
        reservationId: reservation.id,
        sessionId: reservation.event_session_id,
        userId: reservation.user_id,
        status: reservation.status,
        expiresAt: reservation.expires_at,
        totalAmountMinor: Number(reservation.total_amount_minor || 0),
        currency: reservation.currency,
        bookingId: reservation.booking_id || null,
        bookingStatus: reservation.booking_status || null,
        confirmedAt: reservation.confirmed_at || null,
        createdAt: reservation.created_at,
        updatedAt: reservation.updated_at,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`Error querying reservation status ${reservationId}:`, msg);
    res.status(500).json({
      success: false,
      error: {
        code: 'DATABASE_ERROR',
        message: 'Failed to retrieve reservation status',
      },
      timestamp: new Date().toISOString(),
    });
  }
});
