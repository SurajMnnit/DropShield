import request from 'supertest';
import crypto from 'crypto';
import pg from 'pg';
import { createApp } from '../src/app.js';
import { assertTestDatabaseUrl, closeDbPool } from '../src/config/database.js';
import { RedisInventoryService } from '../src/services/inventory.service.js';
import { closeRedisClient } from '../src/config/redis.js';
import { closeRabbitMQClient } from '../src/config/rabbitmq.js';

describe('DropShield Phase 5: Booking API Intake & Status Test Suite', () => {
  const app = createApp();
  let client: pg.Client;
  let inventoryService: RedisInventoryService;

  const testUserId = crypto.randomUUID();
  const otherUserId = crypto.randomUUID();
  const testSessionId = crypto.randomUUID();
  const testVenueId = crypto.randomUUID();
  const testEventId = crypto.randomUUID();

  const seat1Id = crypto.randomUUID();
  const seat2Id = crypto.randomUUID();
  const seat3Id = crypto.randomUUID();

  beforeAll(async () => {
    const testDbUrl = process.env.TEST_DATABASE_URL || 'postgresql://postgres:postgres@localhost:5433/dropshield_test';
    assertTestDatabaseUrl(testDbUrl);

    client = new pg.Client({
      connectionString: testDbUrl,
      connectionTimeoutMillis: 10000,
    });
    await client.connect();

    inventoryService = new RedisInventoryService();

    // 1. Seed database with Users, Venue, Event, Session, and Session Seats
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO users (id, name, email, password_hash, role)
       VALUES ($1, 'Test Buyer', 'buyer_${testUserId}@example.com', 'hash', 'buyer'),
              ($2, 'Other Buyer', 'other_${otherUserId}@example.com', 'hash', 'buyer')
       ON CONFLICT DO NOTHING;`,
      [testUserId, otherUserId]
    );

    await client.query(
      `INSERT INTO venues (id, name, address, city, state, country)
       VALUES ($1, 'API Test Arena', '123 Test Way', 'Mumbai', 'MH', 'India')
       ON CONFLICT DO NOTHING;`,
      [testVenueId]
    );

    await client.query(
      `INSERT INTO venue_seats (id, venue_id, section, row_label, seat_number)
       VALUES ($1, $4, 'A', '1', '1'),
              ($2, $4, 'A', '1', '2'),
              ($3, $4, 'A', '1', '3')
       ON CONFLICT DO NOTHING;`,
      [seat1Id, seat2Id, seat3Id, testVenueId]
    );

    await client.query(
      `INSERT INTO events (id, title, category, status)
       VALUES ($1, 'API Test Concert', 'Music', 'PUBLISHED')
       ON CONFLICT DO NOTHING;`,
      [testEventId]
    );

    await client.query(
      `INSERT INTO event_sessions (id, event_id, venue_id, starts_at, ends_at, status)
       VALUES ($1, $2, $3, CURRENT_TIMESTAMP + INTERVAL '1 day', CURRENT_TIMESTAMP + INTERVAL '1 day 3 hours', 'OPEN')
       ON CONFLICT DO NOTHING;`,
      [testSessionId, testEventId, testVenueId]
    );

    await client.query(
      `INSERT INTO session_seats (id, event_session_id, venue_id, venue_seat_id, status, price_minor)
       VALUES ($1, $4, $5, $1, 'AVAILABLE', 150000),
              ($2, $4, $5, $2, 'AVAILABLE', 150000),
              ($3, $4, $5, $3, 'AVAILABLE', 150000)
       ON CONFLICT DO NOTHING;`,
      [seat1Id, seat2Id, seat3Id, testSessionId, testVenueId]
    );
    await client.query('COMMIT');

    // 2. Pre-populate Redis session seats
    await inventoryService.initializeSession(testSessionId, [
      { seatId: seat1Id },
      { seatId: seat2Id },
      { seatId: seat3Id },
    ]);
  });

  afterAll(async () => {
    await inventoryService.clearSession(testSessionId);
    await client.end();
    await closeDbPool();
    await closeRedisClient();
    await closeRabbitMQClient();
  });

  describe('1. Security & Validation Guards', () => {
    it('rejects unauthenticated requests with 401 Unauthorized', async () => {
      const res = await request(app)
        .post(`/api/v1/sessions/${testSessionId}/reservations`)
        .send({ seatIds: [seat1Id] });

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('UNAUTHORIZED');
    });

    it('rejects missing or short idempotency key with 400 Bad Request', async () => {
      const res = await request(app)
        .post(`/api/v1/sessions/${testSessionId}/reservations`)
        .set('x-user-id', testUserId)
        .set('x-idempotency-key', 'short')
        .send({ seatIds: [seat1Id] });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('MISSING_IDEMPOTENCY_KEY');
    });

    it('rejects invalid or empty seat selection with 400 Bad Request', async () => {
      const res = await request(app)
        .post(`/api/v1/sessions/${testSessionId}/reservations`)
        .set('x-user-id', testUserId)
        .set('x-idempotency-key', 'idemp-valid-key-12345')
        .send({ seatIds: [] });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('rejects duplicate seat IDs in request with 400 Bad Request', async () => {
      const res = await request(app)
        .post(`/api/v1/sessions/${testSessionId}/reservations`)
        .set('x-user-id', testUserId)
        .set('x-idempotency-key', 'idemp-valid-key-dup')
        .send({ seatIds: [seat1Id, seat1Id] });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('DUPLICATE_SEATS');
    });
  });

  describe('2. Intake Processing & 202 Accepted Lifecycle', () => {
    let createdReservationId: string;
    const testIdempotencyKey = 'idemp-flow-' + crypto.randomUUID();

    it('successfully processes valid reservation and returns 202 Accepted', async () => {
      const res = await request(app)
        .post(`/api/v1/sessions/${testSessionId}/reservations`)
        .set('x-user-id', testUserId)
        .set('x-idempotency-key', testIdempotencyKey)
        .send({ seatIds: [seat1Id, seat2Id] });

      expect(res.status).toBe(202);
      expect(res.body.success).toBe(true);
      expect(res.body.data.status).toBe('PENDING');
      expect(res.body.data.sessionId).toBe(testSessionId);
      expect(res.body.data.seatIds).toEqual([seat1Id, seat2Id]);
      expect(res.body.data.statusUrl).toBeDefined();

      createdReservationId = res.body.data.reservationId;

      // Verify Redis seats are now HELD
      const statuses = await inventoryService.getSeatStatuses(testSessionId, [seat1Id, seat2Id]);
      expect(statuses.get(seat1Id)).toBe('HELD');
      expect(statuses.get(seat2Id)).toBe('HELD');

      // Verify Database records exist
      const dbRes = await client.query('SELECT status FROM reservations WHERE id = $1;', [
        createdReservationId,
      ]);
      expect(dbRes.rows[0].status).toBe('PENDING');

      // Verify Outbox event was created
      const outboxRes = await client.query('SELECT event_type FROM outbox_events WHERE aggregate_id = $1;', [
        createdReservationId,
      ]);
      expect(outboxRes.rows.length).toBeGreaterThanOrEqual(1);
      expect(outboxRes.rows[0].event_type).toBe('booking.requested');
    });

    it('replays cached response when identical idempotency key is submitted', async () => {
      const res = await request(app)
        .post(`/api/v1/sessions/${testSessionId}/reservations`)
        .set('x-user-id', testUserId)
        .set('x-idempotency-key', testIdempotencyKey)
        .send({ seatIds: [seat1Id, seat2Id] });

      expect(res.status).toBe(202);
      expect(res.body.success).toBe(true);
      expect(res.body.data.reservationId).toBe(createdReservationId);
    });

    it('rejects hold when seats are already HELD (409 Conflict)', async () => {
      const conflictIdempKey = 'idemp-conflict-' + crypto.randomUUID();
      const res = await request(app)
        .post(`/api/v1/sessions/${testSessionId}/reservations`)
        .set('x-user-id', otherUserId)
        .set('x-idempotency-key', conflictIdempKey)
        .send({ seatIds: [seat1Id] }); // seat1Id is already held!

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('SEAT_UNAVAILABLE');
    });

    it('GET /api/v1/reservations/:id returns durable status from PostgreSQL', async () => {
      const res = await request(app)
        .get(`/api/v1/reservations/${createdReservationId}`)
        .set('x-user-id', testUserId);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.reservationId).toBe(createdReservationId);
      expect(res.body.data.status).toBe('PENDING');
      expect(res.body.data.sessionId).toBe(testSessionId);
    });

    it('GET /api/v1/reservations/:id rejects unauthorized user with 403 Forbidden', async () => {
      const res = await request(app)
        .get(`/api/v1/reservations/${createdReservationId}`)
        .set('x-user-id', otherUserId); // other user!

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    });
  });

  describe('3. Database Failure & Redis Compensation Rollback', () => {
    it('releases Redis hold when database transaction fails (compensation test)', async () => {
      // Create session with single available seat
      const compSessionId = crypto.randomUUID();
      const compSeatId = crypto.randomUUID();

      await inventoryService.initializeSession(compSessionId, [{ seatId: compSeatId }]);

      // We omit inserting compSessionId into PostgreSQL event_sessions,
      // so the DB foreign key constraint fails when attempting to insert reservation!
      const compIdempKey = 'idemp-comp-' + crypto.randomUUID();
      const res = await request(app)
        .post(`/api/v1/sessions/${compSessionId}/reservations`)
        .set('x-user-id', testUserId)
        .set('x-idempotency-key', compIdempKey)
        .send({ seatIds: [compSeatId] });

      expect(res.status).toBe(500);
      expect(res.body.error.code).toBe('PERSISTENCE_ERROR');

      // Verify Redis compensation: seat must NOT remain HELD, should be rolled back to AVAILABLE!
      const statuses = await inventoryService.getSeatStatuses(compSessionId, [compSeatId]);
      expect(statuses.get(compSeatId)).toBe('AVAILABLE');

      await inventoryService.clearSession(compSessionId);
    });
  });
});
