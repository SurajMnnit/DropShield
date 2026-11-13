import crypto from 'crypto';
import pg from 'pg';
import { assertTestDatabaseUrl, closeDbPool } from '../src/config/database.js';
import { getRabbitMQConnection, getRabbitMQConfirmChannel, closeRabbitMQClient } from '../src/config/rabbitmq.js';
import { QUEUE_CONSTANTS, assertBookingTopology } from '../src/queues/topology.js';
import { BookingConsumer } from '../src/queues/booking.consumer.js';
import { RedisInventoryService } from '../src/services/inventory.service.js';
import { closeRedisClient } from '../src/config/redis.js';

describe('DropShield Phase 5: Background Booking Worker & Consumer Test Suite', () => {
  let client: pg.Client;
  let consumer: BookingConsumer;
  let inventoryService: RedisInventoryService;

  const testUserId = crypto.randomUUID();
  const testSessionId = crypto.randomUUID();
  const testVenueId = crypto.randomUUID();
  const testEventId = crypto.randomUUID();

  const seat1Id = crypto.randomUUID();
  const seat2Id = crypto.randomUUID();
  const seatExpiredId = crypto.randomUUID();

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
       VALUES ($1, 'Worker Test User', 'worker_${testUserId}@example.com', 'hash', 'buyer')
       ON CONFLICT DO NOTHING;`,
      [testUserId]
    );

    await client.query(
      `INSERT INTO venues (id, name, address, city, state, country)
       VALUES ($1, 'Worker Test Venue', '456 Worker Road', 'Bangalore', 'KA', 'India')
       ON CONFLICT DO NOTHING;`,
      [testVenueId]
    );

    await client.query(
      `INSERT INTO venue_seats (id, venue_id, section, row_label, seat_number)
       VALUES ($1, $4, 'B', '1', '1'),
              ($2, $4, 'B', '1', '2'),
              ($3, $4, 'B', '1', '3')
       ON CONFLICT DO NOTHING;`,
      [seat1Id, seat2Id, seatExpiredId, testVenueId]
    );

    await client.query(
      `INSERT INTO events (id, title, category, status)
       VALUES ($1, 'Worker Test Event', 'Sports', 'PUBLISHED')
       ON CONFLICT DO NOTHING;`,
      [testEventId]
    );

    await client.query(
      `INSERT INTO event_sessions (id, event_id, venue_id, starts_at, ends_at, status)
       VALUES ($1, $2, $3, CURRENT_TIMESTAMP + INTERVAL '2 days', CURRENT_TIMESTAMP + INTERVAL '2 days 4 hours', 'OPEN')
       ON CONFLICT DO NOTHING;`,
      [testSessionId, testEventId, testVenueId]
    );

    await client.query(
      `INSERT INTO session_seats (id, event_session_id, venue_id, venue_seat_id, status, price_minor)
       VALUES ($1, $4, $5, $1, 'AVAILABLE', 200000),
              ($2, $4, $5, $2, 'AVAILABLE', 200000),
              ($3, $4, $5, $3, 'AVAILABLE', 200000)
       ON CONFLICT DO NOTHING;`,
      [seat1Id, seat2Id, seatExpiredId, testSessionId, testVenueId]
    );
    await client.query('COMMIT');

    // 2. Pre-populate Redis session seats
    await inventoryService.initializeSession(testSessionId, [
      { seatId: seat1Id },
      { seatId: seat2Id },
      { seatId: seatExpiredId },
    ]);

    // 3. Ensure topology and start consumer
    const conn = await getRabbitMQConnection();
    const setupCh = await conn.createChannel();
    await assertBookingTopology(setupCh);
    await setupCh.purgeQueue(QUEUE_CONSTANTS.QUEUE.BOOKING_REQUESTED);
    await setupCh.purgeQueue(QUEUE_CONSTANTS.QUEUE.BOOKING_DEAD);
    await setupCh.close();

    consumer = new BookingConsumer();
    await consumer.start(5);
  });

  afterAll(async () => {
    await consumer.stop();
    await inventoryService.clearSession(testSessionId);
    await client.end();
    await closeDbPool();
    await closeRedisClient();
    await closeRabbitMQClient();
  });

  describe('1. Successful Message Processing & Durable State Transition', () => {
    it('consumes booking-requested event, validates database hold, and acknowledges message', async () => {
      const reservationId = crypto.randomUUID();
      const idempotencyKey = 'idemp-worker-' + crypto.randomUUID();
      const expiresAt = new Date(Date.now() + 600000); // 10 minutes from now

      // Hold seats in Redis
      await inventoryService.holdSeats({
        sessionId: testSessionId,
        userId: testUserId,
        reservationId,
        seatIds: [seat1Id],
        idempotencyKey,
      });

      // Insert reservation and update session_seats in DB
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO reservations (
          id, user_id, event_session_id, status, expires_at, total_amount_minor, currency, idempotency_key
        ) VALUES ($1, $2, $3, 'PENDING', $4, 200000, 'INR', $5);`,
        [reservationId, testUserId, testSessionId, expiresAt, idempotencyKey]
      );
      await client.query(
        `UPDATE session_seats
         SET status = 'HELD', current_reservation_id = $1, hold_expires_at = $2
         WHERE id = $3 AND event_session_id = $4;`,
        [reservationId, expiresAt, seat1Id, testSessionId]
      );
      await client.query('COMMIT');

      // Publish booking.requested event to RabbitMQ
      const confirmChannel = await getRabbitMQConfirmChannel();
      const eventMessage = {
        eventId: crypto.randomUUID(),
        eventType: 'booking.requested',
        version: 'v1',
        timestamp: new Date().toISOString(),
        payload: {
          reservationId,
          sessionId: testSessionId,
          userId: testUserId,
          seatIds: [seat1Id],
          idempotencyKey,
          expiresAt: expiresAt.toISOString(),
          totalAmountMinor: 200000,
          currency: 'INR',
        },
      };

      await new Promise<void>((resolve, reject) => {
        confirmChannel.publish(
          QUEUE_CONSTANTS.EXCHANGE.BOOKING,
          QUEUE_CONSTANTS.ROUTING_KEY.BOOKING_REQUESTED,
          Buffer.from(JSON.stringify(eventMessage)),
          { persistent: true },
          (err) => (err ? reject(err) : resolve())
        );
      });

      // Wait briefly for consumer processing
      await new Promise((resolve) => setTimeout(resolve, 300));

      // Verify reservation is still valid in DB
      const resCheck = await client.query('SELECT status, updated_at FROM reservations WHERE id = $1;', [
        reservationId,
      ]);
      expect(resCheck.rows[0].status).toBe('PENDING');
      expect(resCheck.rows[0].updated_at).toBeDefined();
    });
  });

  describe('2. Idempotency & Duplicate Delivery', () => {
    it('handles redelivery of already-processed event gracefully without duplicate side-effects', async () => {
      const reservationId = crypto.randomUUID();
      const idempotencyKey = 'idemp-dup-' + crypto.randomUUID();

      // Seed reservation with already processed status 'CONFIRMED'
      await client.query(
        `INSERT INTO reservations (
          id, user_id, event_session_id, status, expires_at, total_amount_minor, currency, idempotency_key
        ) VALUES ($1, $2, $3, 'CONFIRMED', CURRENT_TIMESTAMP + INTERVAL '1 hour', 200000, 'INR', $4);`,
        [reservationId, testUserId, testSessionId, idempotencyKey]
      );

      const confirmChannel = await getRabbitMQConfirmChannel();
      const eventMessage = {
        eventId: crypto.randomUUID(),
        eventType: 'booking.requested',
        version: 'v1',
        timestamp: new Date().toISOString(),
        payload: {
          reservationId,
          sessionId: testSessionId,
          userId: testUserId,
          seatIds: [seat2Id],
          idempotencyKey,
          expiresAt: new Date(Date.now() + 3600000).toISOString(),
          totalAmountMinor: 200000,
          currency: 'INR',
        },
      };

      // Publish duplicate message
      await new Promise<void>((resolve, reject) => {
        confirmChannel.publish(
          QUEUE_CONSTANTS.EXCHANGE.BOOKING,
          QUEUE_CONSTANTS.ROUTING_KEY.BOOKING_REQUESTED,
          Buffer.from(JSON.stringify(eventMessage)),
          { persistent: true },
          (err) => (err ? reject(err) : resolve())
        );
      });

      // Consumer should ack without throwing error
      await new Promise((resolve) => setTimeout(resolve, 300));

      const resCheck = await client.query('SELECT status FROM reservations WHERE id = $1;', [
        reservationId,
      ]);
      expect(resCheck.rows[0].status).toBe('CONFIRMED');
    });
  });

  describe('3. Queue Expiration & Cleanup', () => {
    it('detects reservation expired while in queue, marks EXPIRED in DB and releases Redis hold', async () => {
      const reservationId = crypto.randomUUID();
      const idempotencyKey = 'idemp-exp-q-' + crypto.randomUUID();
      const expiredAt = new Date(Date.now() - 5000); // Expired 5 seconds ago!

      // Hold in Redis
      await inventoryService.holdSeats({
        sessionId: testSessionId,
        userId: testUserId,
        reservationId,
        seatIds: [seatExpiredId],
        idempotencyKey,
      });

      // Insert PENDING in DB
      await client.query(
        `INSERT INTO reservations (
          id, user_id, event_session_id, status, expires_at, total_amount_minor, currency, idempotency_key
        ) VALUES ($1, $2, $3, 'PENDING', $4, 200000, 'INR', $5);`,
        [reservationId, testUserId, testSessionId, expiredAt, idempotencyKey]
      );

      const confirmChannel = await getRabbitMQConfirmChannel();
      const eventMessage = {
        eventId: crypto.randomUUID(),
        eventType: 'booking.requested',
        version: 'v1',
        timestamp: new Date().toISOString(),
        payload: {
          reservationId,
          sessionId: testSessionId,
          userId: testUserId,
          seatIds: [seatExpiredId],
          idempotencyKey,
          expiresAt: expiredAt.toISOString(),
          totalAmountMinor: 200000,
          currency: 'INR',
        },
      };

      // Publish expired message
      await new Promise<void>((resolve, reject) => {
        confirmChannel.publish(
          QUEUE_CONSTANTS.EXCHANGE.BOOKING,
          QUEUE_CONSTANTS.ROUTING_KEY.BOOKING_REQUESTED,
          Buffer.from(JSON.stringify(eventMessage)),
          { persistent: true },
          (err) => (err ? reject(err) : resolve())
        );
      });

      await new Promise((resolve) => setTimeout(resolve, 350));

      // Verify DB marked EXPIRED
      const resCheck = await client.query('SELECT status FROM reservations WHERE id = $1;', [
        reservationId,
      ]);
      expect(resCheck.rows[0].status).toBe('EXPIRED');

      // Verify Redis seat is reclaimed to AVAILABLE
      const statuses = await inventoryService.getSeatStatuses(testSessionId, [seatExpiredId]);
      expect(statuses.get(seatExpiredId)).toBe('AVAILABLE');
    });
  });

  describe('4. Dead-Letter & Invalid Message Handling', () => {
    it('corrupted or invalid payload is immediately routed to dead-letter queue (DLQ)', async () => {
      const conn = await getRabbitMQConnection();
      const checkCh = await conn.createChannel();
      await assertBookingTopology(checkCh);
      await checkCh.purgeQueue(QUEUE_CONSTANTS.QUEUE.BOOKING_DEAD);

      const confirmChannel = await getRabbitMQConfirmChannel();

      // Publish malformed message (missing required payload and version)
      const invalidMessage = Buffer.from(JSON.stringify({ badField: true, corrupt: 'data' }));

      await new Promise<void>((resolve, reject) => {
        confirmChannel.publish(
          QUEUE_CONSTANTS.EXCHANGE.BOOKING,
          QUEUE_CONSTANTS.ROUTING_KEY.BOOKING_REQUESTED,
          invalidMessage,
          { persistent: true },
          (err) => (err ? reject(err) : resolve())
        );
      });

      let found = false;
      for (let attempt = 0; attempt < 20; attempt++) {
        await new Promise((r) => setTimeout(r, 100));
        const dlqMsg = await checkCh.get(QUEUE_CONSTANTS.QUEUE.BOOKING_DEAD, { noAck: true });
        if (dlqMsg) {
          try {
            const content = JSON.parse(dlqMsg.content.toString());
            if (content.corrupt === 'data') {
              found = true;
              break;
            }
          } catch {
            // ignore non-json
          }
        }
      }
      expect(found).toBe(true);

      await checkCh.close();
    });
  });
});
