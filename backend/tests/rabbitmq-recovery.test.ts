import crypto from 'crypto';
import { dbPool } from '../src/config/database.js';
import { getRabbitMQConnection, getRabbitMQConfirmChannel, closeRabbitMQClient } from '../src/config/rabbitmq.js';
import { QUEUE_CONSTANTS, assertBookingTopology } from '../src/queues/topology.js';
import { BookingConsumer } from '../src/queues/booking.consumer.js';
import { DeadLetterService } from '../src/services/dlq.service.js';
import { failureInjector } from '../src/testing/failure-injector.js';

describe('Phase 7: RabbitMQ & Worker Failure Recovery Test Suite', () => {
  const dlqService = new DeadLetterService();
  let consumer: BookingConsumer;

  const userId = crypto.randomUUID();
  const venueId = crypto.randomUUID();
  const eventId = crypto.randomUUID();
  const sessionId = crypto.randomUUID();
  const venueSeatId = crypto.randomUUID();
  const sessionSeatId = crypto.randomUUID();

  beforeAll(async () => {
    // 1. Create User
    await dbPool.query(
      `INSERT INTO users (id, name, email, password_hash, role)
       VALUES ($1, 'RabbitMQ Recovery User', $2, 'hashed_pw', 'buyer');`,
      [userId, `rmq_rec.${Date.now()}@example.com`]
    );

    // 2. Create Venue & Seats
    await dbPool.query(
      `INSERT INTO venues (id, name, address, city, state, country)
       VALUES ($1, 'AMQP Resilience Pavilion', '300 Queue Rd', 'Bengaluru', 'KA', 'India');`,
      [venueId]
    );

    await dbPool.query(
      `INSERT INTO venue_seats (id, venue_id, section, row_label, seat_number, seat_type)
       VALUES ($1, $2, 'Grand Tier', 'B', '5', 'Standard');`,
      [venueSeatId, venueId]
    );

    // 3. Create Event & Session
    await dbPool.query(
      `INSERT INTO events (id, title, description, category, status)
       VALUES ($1, 'Queue Resilience Forum', 'Worker Crash Scenarios', 'Tech', 'PUBLISHED');`,
      [eventId]
    );

    const startsAt = new Date(Date.now() + 86400000);
    const endsAt = new Date(Date.now() + 90000000);
    await dbPool.query(
      `INSERT INTO event_sessions (id, event_id, venue_id, starts_at, ends_at, status)
       VALUES ($1, $2, $3, $4, $5, 'OPEN');`,
      [sessionId, eventId, venueId, startsAt, endsAt]
    );

    // 4. Create Session Seat
    await dbPool.query(
      `INSERT INTO session_seats (id, event_session_id, venue_id, venue_seat_id, status, price_minor)
       VALUES ($1, $2, $3, $4, 'AVAILABLE', 45000);`,
      [sessionSeatId, sessionId, venueId, venueSeatId]
    );

    // Purge DLQ to start clean
    const conn = await getRabbitMQConnection();
    const ch = await conn.createChannel();
    await assertBookingTopology(ch);
    await ch.purgeQueue(QUEUE_CONSTANTS.QUEUE.BOOKING_DEAD);
    await ch.purgeQueue(QUEUE_CONSTANTS.QUEUE.BOOKING_REQUESTED);
    await ch.close().catch(() => {});

    // Start Consumer
    consumer = new BookingConsumer();
    await consumer.start();
  });

  afterAll(async () => {
    failureInjector.reset();
    await consumer.stop();
    await closeRabbitMQClient();
  });

  afterEach(() => {
    failureInjector.reset();
  });

  it('routes poison-pill message directly to dead-letter queue (DLQ)', async () => {
    const confirmChannel = await getRabbitMQConfirmChannel();
    const malformedPayload = Buffer.from('NOT_A_VALID_JSON_OBJECT_{{');

    // Publish to main exchange
    await new Promise<void>((resolve, reject) => {
      confirmChannel.publish(
        QUEUE_CONSTANTS.EXCHANGE.BOOKING,
        QUEUE_CONSTANTS.ROUTING_KEY.BOOKING_REQUESTED,
        malformedPayload,
        { persistent: true },
        (err) => (err ? reject(err) : resolve())
      );
    });

    // Wait for consumer handling
    await new Promise((res) => setTimeout(res, 300));

    // Inspect DLQ non-destructively
    const inspection = await dlqService.inspectDeadLetterQueue(10);
    expect(inspection.totalMessages).toBeGreaterThanOrEqual(1);

    const poisonPill = inspection.items.find((i) => i.deathReason === 'rejected' || !i.eligibleForReplay);
    expect(poisonPill).toBeDefined();
    expect(poisonPill?.eligibleForReplay).toBe(false);
  });

  it('safely replays DLQ messages and discards obsolete or expired records', async () => {
    const obsoleteResId = crypto.randomUUID();
    const futureExpiresAt = new Date(Date.now() + 600000);

    // Create a confirmed reservation in DB (already processed)
    await dbPool.query(
      `INSERT INTO reservations (id, user_id, event_session_id, status, expires_at, total_amount_minor, currency, idempotency_key)
       VALUES ($1, $2, $3, 'CONFIRMED', $4, 45000, 'INR', $5);`,
      [obsoleteResId, userId, sessionId, futureExpiresAt, `idemp_dlq_${Date.now()}`]
    );

    // Push obsolete message directly to DLQ
    const conn = await getRabbitMQConnection();
    const ch = await conn.createChannel();
    const obsoletePayload = {
      eventId: crypto.randomUUID(),
      eventType: 'booking.requested',
      version: 'v1',
      payload: {
        reservationId: obsoleteResId,
        sessionId,
        userId,
        seatIds: [sessionSeatId],
        expiresAt: futureExpiresAt.toISOString(),
      },
    };

    ch.sendToQueue(
      QUEUE_CONSTANTS.QUEUE.BOOKING_DEAD,
      Buffer.from(JSON.stringify(obsoletePayload)),
      {
        persistent: true,
        headers: {
          'x-death': [
            {
              reason: 'rejected',
              queue: QUEUE_CONSTANTS.QUEUE.BOOKING_REQUESTED,
              count: 1,
            },
          ],
        },
      }
    );

    await ch.close().catch(() => {});

    // Execute Replay
    const replayReport = await dlqService.replayDeadLetterMessages(20);
    expect(replayReport.totalProcessed).toBeGreaterThan(0);
    // Since reservation is already CONFIRMED, it must be discarded as duplicate/processed
    expect(replayReport.discardedDuplicatesCount).toBeGreaterThanOrEqual(1);
  });

  it('recovers cleanly when WORKER_CRASH_BEFORE_ACK is injected', async () => {
    const crashResId = crypto.randomUUID();
    const futureExpiresAt = new Date(Date.now() + 600000);

    // Insert reservation and held seat in DB
    await dbPool.query(
      `INSERT INTO reservations (id, user_id, event_session_id, status, expires_at, total_amount_minor, currency, idempotency_key)
       VALUES ($1, $2, $3, 'PENDING', $4, 45000, 'INR', $5);`,
      [crashResId, userId, sessionId, futureExpiresAt, `idemp_crash_${Date.now()}`]
    );

    await dbPool.query(
      `UPDATE session_seats
       SET status = 'HELD', current_reservation_id = $1, hold_expires_at = $2
       WHERE id = $3;`,
      [crashResId, futureExpiresAt, sessionSeatId]
    );

    // Arm failure hook for WORKER_CRASH_BEFORE_ACK (triggers once)
    failureInjector.inject({
      point: 'WORKER_CRASH_BEFORE_ACK',
      times: 1,
    });

    const confirmChannel = await getRabbitMQConfirmChannel();
    const eventPayload = {
      eventId: crypto.randomUUID(),
      eventType: 'booking.requested',
      version: 'v1',
      payload: {
        reservationId: crashResId,
        sessionId,
        userId,
        seatIds: [sessionSeatId],
        idempotencyKey: `idemp_crash_${Date.now()}`,
        expiresAt: futureExpiresAt.toISOString(),
        totalAmountMinor: 45000,
        currency: 'INR',
      },
    };

    await new Promise<void>((resolve, reject) => {
      confirmChannel.publish(
        QUEUE_CONSTANTS.EXCHANGE.BOOKING,
        QUEUE_CONSTANTS.ROUTING_KEY.BOOKING_REQUESTED,
        Buffer.from(JSON.stringify(eventPayload)),
        { persistent: true },
        (err) => (err ? reject(err) : resolve())
      );
    });

    // Wait for crash and retry routing
    await new Promise((res) => setTimeout(res, 500));

    // Verify DB integrity remains preserved (reservation remains valid)
    const resCheck = await dbPool.query(`SELECT status FROM reservations WHERE id = $1;`, [crashResId]);
    expect(resCheck.rows[0].status).toBe('PENDING');
  });
});
