import request from 'supertest';
import crypto from 'crypto';
import { createApp } from '../src/app.js';
import { dbPool } from '../src/config/database.js';
import { RedisInventoryService } from '../src/services/inventory.service.js';

const app = createApp();
const inventoryService = new RedisInventoryService();

describe('Phase 6: Events & Sessions Discovery Test Suite', () => {
  const eventId = crypto.randomUUID();
  const venueId = crypto.randomUUID();
  const sessionId = crypto.randomUUID();
  const venueSeatId1 = crypto.randomUUID();
  const venueSeatId2 = crypto.randomUUID();
  const sessionSeatId1 = crypto.randomUUID();
  const sessionSeatId2 = crypto.randomUUID();

  beforeAll(async () => {
    // 1. Create venue
    await dbPool.query(
      `INSERT INTO venues (id, name, address, city, state, country)
       VALUES ($1, 'Discovery Arena', '123 Test St', 'Mumbai', 'Maharashtra', 'India');`,
      [venueId]
    );

    // 2. Create venue seats
    await dbPool.query(
      `INSERT INTO venue_seats (id, venue_id, section, row_label, seat_number, seat_type)
       VALUES 
       ($1, $2, 'Balcony', 'A', '1', 'VIP'),
       ($3, $2, 'Balcony', 'A', '2', 'STANDARD');`,
      [venueSeatId1, venueId, venueSeatId2]
    );

    // 3. Create published event
    await dbPool.query(
      `INSERT INTO events (id, title, description, category, status)
       VALUES ($1, 'Discovery Rock Festival', 'Annual music fest', 'Music', 'PUBLISHED');`,
      [eventId]
    );

    // 4. Create session
    const startsAt = new Date(Date.now() + 86400000);
    const endsAt = new Date(Date.now() + 90000000);
    await dbPool.query(
      `INSERT INTO event_sessions (id, event_id, venue_id, starts_at, ends_at, status)
       VALUES ($1, $2, $3, $4, $5, 'OPEN');`,
      [sessionId, eventId, venueId, startsAt, endsAt]
    );

    // 5. Create session seats
    await dbPool.query(
      `INSERT INTO session_seats (id, event_session_id, venue_id, venue_seat_id, status, price_minor)
       VALUES 
       ($1, $2, $3, $4, 'AVAILABLE', 50000),
       ($5, $2, $3, $6, 'AVAILABLE', 35000);`,
      [sessionSeatId1, sessionId, venueId, venueSeatId1, sessionSeatId2, venueSeatId2]
    );

    // 6. Initialize Redis inventory for this session
    await inventoryService.initializeSession(sessionId, [
      { seatId: sessionSeatId1, status: 'AVAILABLE' },
      { seatId: sessionSeatId2, status: 'AVAILABLE' },
    ]);
  });

  afterAll(async () => {
    // Clean up
    await dbPool.query(`DELETE FROM session_seats WHERE event_session_id = $1;`, [sessionId]);
    await dbPool.query(`DELETE FROM event_sessions WHERE id = $1;`, [sessionId]);
    await dbPool.query(`DELETE FROM events WHERE id = $1;`, [eventId]);
    await dbPool.query(`DELETE FROM venue_seats WHERE venue_id = $1;`, [venueId]);
    await dbPool.query(`DELETE FROM venues WHERE id = $1;`, [venueId]);
  });

  it('GET /api/v1/events returns published events with pagination', async () => {
    const res = await request(app).get('/api/v1/events?page=1&limit=10');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data.events)).toBe(true);
    expect(res.body.data.pagination.page).toBe(1);

    const found = res.body.data.events.find((e: { id: string }) => e.id === eventId);
    expect(found).toBeDefined();
    expect(found.title).toBe('Discovery Rock Festival');
  });

  it('GET /api/v1/events?category=Music filters events correctly', async () => {
    const res = await request(app).get('/api/v1/events?category=Music');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    const matches = res.body.data.events.filter((e: { category: string }) => e.category === 'Music');
    expect(matches.length).toBeGreaterThanOrEqual(1);
  });

  it('GET /api/v1/events/:id returns single event details', async () => {
    const res = await request(app).get(`/api/v1/events/${eventId}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.event.id).toBe(eventId);
    expect(res.body.data.event.title).toBe('Discovery Rock Festival');
  });

  it('GET /api/v1/events/:id/sessions returns event sessions with venue', async () => {
    const res = await request(app).get(`/api/v1/events/${eventId}/sessions`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data.sessions)).toBe(true);
    expect(res.body.data.sessions.length).toBeGreaterThanOrEqual(1);
    expect(res.body.data.sessions[0].venue_name).toBe('Discovery Arena');
  });

  it('GET /api/v1/sessions/:sessionId returns session details', async () => {
    const res = await request(app).get(`/api/v1/sessions/${sessionId}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.id).toBe(sessionId);
    expect(res.body.data.venueName).toBe('Discovery Arena');
  });

  it('GET /api/v1/sessions/:sessionId/seats returns real-time merged seats', async () => {
    const res = await request(app).get(`/api/v1/sessions/${sessionId}/seats`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.seats.length).toBe(2);
    expect(res.body.data.summary.available).toBe(2);

    // Now hold one seat in Redis and verify real-time status updates to HELD
    const dummyReservationId = crypto.randomUUID();
    const dummyUserId = crypto.randomUUID();
    await inventoryService.holdSeats({
      sessionId,
      reservationId: dummyReservationId,
      userId: dummyUserId,
      seatIds: [sessionSeatId1],
      idempotencyKey: 'idemp_dummy_test',
      holdTtlSeconds: 60,
    });

    const resAfterHold = await request(app).get(`/api/v1/sessions/${sessionId}/seats`);
    expect(resAfterHold.status).toBe(200);
    const heldSeat = resAfterHold.body.data.seats.find((s: { id: string }) => s.id === sessionSeatId1);
    expect(heldSeat.status).toBe('HELD');
    expect(resAfterHold.body.data.summary.held).toBe(1);
    expect(resAfterHold.body.data.summary.available).toBe(1);
  });
});
