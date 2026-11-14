import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { dbPool } from '../config/database.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

export const eventsRouter = Router();

const uuidParamSchema = z.string().uuid({ message: 'Invalid UUID format' });

const createEventSchema = z.object({
  title: z.string().min(3).max(255),
  description: z.string().optional().default(''),
  category: z.string().min(2).max(100),
  status: z.enum(['DRAFT', 'PUBLISHED', 'ARCHIVED', 'CANCELLED']).optional().default('PUBLISHED'),
});

const createSessionSchema = z.object({
  venueId: z.string().uuid(),
  startsAt: z.string().datetime(),
  endsAt: z.string().datetime(),
  status: z.enum(['SCHEDULED', 'OPEN', 'COMPLETED', 'CANCELLED', 'POSTPONED']).optional().default('OPEN'),
});

/**
 * GET /api/v1/events
 * Public event discovery with pagination and category filtering.
 */
eventsRouter.get('/events', async (req: Request, res: Response) => {
  const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit as string, 10) || 20));
  const offset = (page - 1) * limit;
  const category = req.query.category as string | undefined;

  try {
    let countQuery = 'SELECT COUNT(*) as total FROM events WHERE status = $1';
    let dataQuery = `
      SELECT e.id, e.title, e.description, e.category, e.status, e.created_at,
             COUNT(s.id) as sessions_count
      FROM events e
      LEFT JOIN event_sessions s ON s.event_id = e.id AND s.status IN ('OPEN', 'SCHEDULED')
      WHERE e.status = $1
    `;
    const params: unknown[] = ['PUBLISHED'];

    if (category && category.trim() !== '') {
      params.push(category.trim());
      countQuery += ' AND category = $2';
      dataQuery += ` AND e.category = $2`;
    }

    dataQuery += ` GROUP BY e.id ORDER BY e.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2};`;
    const queryParams = [...params, limit, offset];

    const [countRes, dataRes] = await Promise.all([
      dbPool.query(countQuery, params),
      dbPool.query(dataQuery, queryParams),
    ]);

    const total = parseInt(countRes.rows[0].total, 10);

    res.status(200).json({
      success: true,
      data: {
        events: dataRes.rows.map((row) => ({
          id: row.id,
          title: row.title,
          description: row.description,
          category: row.category,
          status: row.status,
          sessionsCount: parseInt(row.sessions_count, 10),
          createdAt: row.created_at,
        })),
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
      },
      timestamp: new Date().toISOString(),
    });
  } catch (_err: unknown) {
    res.status(500).json({
      success: false,
      error: { code: 'DATABASE_ERROR', message: 'Failed to retrieve events' },
      timestamp: new Date().toISOString(),
    });
  }
});

/**
 * GET /api/v1/events/:eventId
 */
eventsRouter.get('/events/:eventId', async (req: Request, res: Response) => {
  const paramResult = uuidParamSchema.safeParse(req.params.eventId);
  if (!paramResult.success) {
    res.status(400).json({
      success: false,
      error: { code: 'INVALID_EVENT_ID', message: 'Invalid event ID' },
      timestamp: new Date().toISOString(),
    });
    return;
  }
  const eventId = paramResult.data;

  try {
    const eventRes = await dbPool.query(
      `SELECT id, title, description, category, status, created_at, updated_at
       FROM events WHERE id = $1;`,
      [eventId]
    );

    if (eventRes.rows.length === 0) {
      res.status(404).json({
        success: false,
        error: { code: 'EVENT_NOT_FOUND', message: 'Event not found' },
        timestamp: new Date().toISOString(),
      });
      return;
    }

    const sessionsRes = await dbPool.query(
      `SELECT s.id, s.venue_id, s.starts_at, s.ends_at, s.status,
              v.name as venue_name, v.city as venue_city, v.state as venue_state
       FROM event_sessions s
       JOIN venues v ON v.id = s.venue_id
       WHERE s.event_id = $1
       ORDER BY s.starts_at ASC;`,
      [eventId]
    );

    res.status(200).json({
      success: true,
      data: {
        event: eventRes.rows[0],
        sessions: sessionsRes.rows.map((s) => ({
          id: s.id,
          venueId: s.venue_id,
          venueName: s.venue_name,
          venueCity: s.venue_city,
          venueState: s.venue_state,
          startsAt: s.starts_at,
          endsAt: s.ends_at,
          status: s.status,
        })),
      },
      timestamp: new Date().toISOString(),
    });
  } catch (_err: unknown) {
    res.status(500).json({
      success: false,
      error: { code: 'DATABASE_ERROR', message: 'Failed to retrieve event details' },
      timestamp: new Date().toISOString(),
    });
  }
});

/**
 * GET /api/v1/events/:eventId/sessions
 */
eventsRouter.get('/events/:eventId/sessions', async (req: Request, res: Response) => {
  const paramResult = uuidParamSchema.safeParse(req.params.eventId);
  if (!paramResult.success) {
    res.status(400).json({
      success: false,
      error: { code: 'INVALID_EVENT_ID', message: 'Invalid event ID' },
      timestamp: new Date().toISOString(),
    });
    return;
  }
  const eventId = paramResult.data;

  try {
    const sessionsRes = await dbPool.query(
      `SELECT s.id, s.event_id, s.venue_id, s.starts_at, s.ends_at, s.status,
              v.name as venue_name, v.address as venue_address, v.city as venue_city, v.state as venue_state
       FROM event_sessions s
       JOIN venues v ON v.id = s.venue_id
       WHERE s.event_id = $1
       ORDER BY s.starts_at ASC;`,
      [eventId]
    );

    res.status(200).json({
      success: true,
      data: {
        sessions: sessionsRes.rows,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (_err: unknown) {
    res.status(500).json({
      success: false,
      error: { code: 'DATABASE_ERROR', message: 'Failed to retrieve event sessions' },
      timestamp: new Date().toISOString(),
    });
  }
});

/**
 * POST /api/v1/events (Admin only)
 */
eventsRouter.post('/events', requireAuth, requireRole('admin'), async (req: Request, res: Response) => {
  const parsed = createEventSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: 'Invalid event data', details: parsed.error.format() },
      timestamp: new Date().toISOString(),
    });
    return;
  }

  try {
    const insertRes = await dbPool.query(
      `INSERT INTO events (title, description, category, status)
       VALUES ($1, $2, $3, $4)
       RETURNING *;`,
      [parsed.data.title, parsed.data.description, parsed.data.category, parsed.data.status]
    );

    res.status(201).json({
      success: true,
      data: { event: insertRes.rows[0] },
      timestamp: new Date().toISOString(),
    });
  } catch (_err: unknown) {
    res.status(500).json({
      success: false,
      error: { code: 'EVENT_CREATION_FAILED', message: 'Failed to create event' },
      timestamp: new Date().toISOString(),
    });
  }
});

/**
 * POST /api/v1/events/:eventId/sessions (Admin only)
 */
eventsRouter.post('/events/:eventId/sessions', requireAuth, requireRole('admin'), async (req: Request, res: Response) => {
  const eventIdResult = uuidParamSchema.safeParse(req.params.eventId);
  if (!eventIdResult.success) {
    res.status(400).json({
      success: false,
      error: { code: 'INVALID_EVENT_ID', message: 'Invalid event ID' },
      timestamp: new Date().toISOString(),
    });
    return;
  }
  const eventId = eventIdResult.data;

  const parsed = createSessionSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: 'Invalid session data', details: parsed.error.format() },
      timestamp: new Date().toISOString(),
    });
    return;
  }

  try {
    const insertRes = await dbPool.query(
      `INSERT INTO event_sessions (event_id, venue_id, starts_at, ends_at, status)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *;`,
      [eventId, parsed.data.venueId, parsed.data.startsAt, parsed.data.endsAt, parsed.data.status]
    );

    res.status(201).json({
      success: true,
      data: { session: insertRes.rows[0] },
      timestamp: new Date().toISOString(),
    });
  } catch (_err: unknown) {
    res.status(500).json({
      success: false,
      error: { code: 'SESSION_CREATION_FAILED', message: 'Failed to create event session' },
      timestamp: new Date().toISOString(),
    });
  }
});
