import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { dbPool } from '../config/database.js';
import { RedisInventoryService } from '../services/inventory.service.js';

export const sessionsRouter = Router();

const uuidParamSchema = z.string().uuid({ message: 'Invalid UUID format' });
const inventoryService = new RedisInventoryService();

/**
 * GET /api/v1/sessions/:sessionId
 * Retrieves session details and venue information.
 */
sessionsRouter.get('/sessions/:sessionId', async (req: Request, res: Response) => {
  const paramResult = uuidParamSchema.safeParse(req.params.sessionId);
  if (!paramResult.success) {
    res.status(400).json({
      success: false,
      error: { code: 'INVALID_SESSION_ID', message: 'Invalid session ID' },
      timestamp: new Date().toISOString(),
    });
    return;
  }
  const sessionId = paramResult.data;

  try {
    const sessionRes = await dbPool.query(
      `SELECT s.id, s.event_id, s.venue_id, s.starts_at, s.ends_at, s.status,
              e.title as event_title, e.category as event_category,
              v.name as venue_name, v.address as venue_address, v.city as venue_city, v.state as venue_state
       FROM event_sessions s
       JOIN events e ON e.id = s.event_id
       JOIN venues v ON v.id = s.venue_id
       WHERE s.id = $1;`,
      [sessionId]
    );

    if (sessionRes.rows.length === 0) {
      res.status(404).json({
        success: false,
        error: { code: 'SESSION_NOT_FOUND', message: 'Session not found' },
        timestamp: new Date().toISOString(),
      });
      return;
    }

    const row = sessionRes.rows[0];
    res.status(200).json({
      success: true,
      data: {
        id: row.id,
        eventId: row.event_id,
        venueId: row.venue_id,
        startsAt: row.starts_at,
        endsAt: row.ends_at,
        status: row.status,
        eventTitle: row.event_title,
        eventCategory: row.event_category,
        venueName: row.venue_name,
        venueAddress: row.venue_address,
        venueCity: row.venue_city,
        venueState: row.venue_state,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (_err: unknown) {
    res.status(500).json({
      success: false,
      error: { code: 'DATABASE_ERROR', message: 'Failed to retrieve session details' },
      timestamp: new Date().toISOString(),
    });
  }
});

/**
 * GET /api/v1/sessions/:sessionId/seats
 * Returns live authoritative seat inventory.
 * Merges relational database rows with real-time Redis hold leases.
 */
sessionsRouter.get('/sessions/:sessionId/seats', async (req: Request, res: Response) => {
  const paramResult = uuidParamSchema.safeParse(req.params.sessionId);
  if (!paramResult.success) {
    res.status(400).json({
      success: false,
      error: { code: 'INVALID_SESSION_ID', message: 'Invalid session ID' },
      timestamp: new Date().toISOString(),
    });
    return;
  }
  const sessionId = paramResult.data;

  try {
    // 1. Fetch seat records from database
    const dbSeatsRes = await dbPool.query(
      `SELECT ss.id, ss.status, ss.price_minor,
              vs.section, vs.row_label, vs.seat_number, vs.seat_type
       FROM session_seats ss
       JOIN venue_seats vs ON vs.id = ss.venue_seat_id
       WHERE ss.event_session_id = $1
       ORDER BY vs.section ASC, vs.row_label ASC, vs.seat_number::int ASC;`,
      [sessionId]
    );

    if (dbSeatsRes.rows.length === 0) {
      res.status(404).json({
        success: false,
        error: { code: 'NO_SEATS_FOUND', message: 'No seats configured for this session' },
        timestamp: new Date().toISOString(),
      });
      return;
    }

    const seatIds = dbSeatsRes.rows.map((s) => s.id);

    // 2. Fetch live Redis statuses for in-memory hold/booked overrides
    let redisStatuses = new Map<string, string>();
    try {
      redisStatuses = await inventoryService.getSeatStatuses(sessionId, seatIds);
    } catch {
      // In case Redis is temporarily restarting, fall back gracefully to database state
    }

    // 3. Merge states: Redis in-memory hold/booked status takes precedence over DB state
    const mergedSeats = dbSeatsRes.rows.map((seat) => {
      let authoritativeStatus: 'AVAILABLE' | 'HELD' | 'BOOKED' = seat.status;

      const redisStatus = redisStatuses.get(seat.id);
      if (redisStatus === 'HELD' || redisStatus === 'BOOKED') {
        authoritativeStatus = redisStatus;
      } else if (redisStatus === 'AVAILABLE' && seat.status === 'HELD') {
        // If expired in Redis and reclaimed, reflect AVAILABLE
        authoritativeStatus = 'AVAILABLE';
      }

      return {
        id: seat.id,
        section: seat.section,
        row: seat.row_label,
        seatNumber: seat.seat_number,
        type: seat.seat_type,
        priceMinor: Number(seat.price_minor || 0),
        status: authoritativeStatus,
      };
    });

    const summary = {
      total: mergedSeats.length,
      available: mergedSeats.filter((s) => s.status === 'AVAILABLE').length,
      held: mergedSeats.filter((s) => s.status === 'HELD').length,
      booked: mergedSeats.filter((s) => s.status === 'BOOKED').length,
    };

    res.status(200).json({
      success: true,
      data: {
        sessionId,
        summary,
        seats: mergedSeats,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (_err: unknown) {
    res.status(500).json({
      success: false,
      error: { code: 'DATABASE_ERROR', message: 'Failed to retrieve session seat availability' },
      timestamp: new Date().toISOString(),
    });
  }
});
