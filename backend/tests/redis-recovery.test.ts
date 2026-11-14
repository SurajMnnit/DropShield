import crypto from 'crypto';
import { dbPool } from '../src/config/database.js';
import { getRedisClient } from '../src/config/redis.js';
import { RedisKeys } from '../src/redis/keys.js';
import { RedisInventoryService } from '../src/services/inventory.service.js';
import { failureInjector } from '../src/testing/failure-injector.js';

describe('Phase 7: Redis Failure & Recovery Test Suite', () => {
  const inventoryService = new RedisInventoryService();

  const userId = crypto.randomUUID();
  const venueId = crypto.randomUUID();
  const eventId = crypto.randomUUID();
  const sessionId = crypto.randomUUID();
  const venueSeatId1 = crypto.randomUUID();
  const venueSeatId2 = crypto.randomUUID();
  const sessionSeatId1 = crypto.randomUUID();
  const sessionSeatId2 = crypto.randomUUID();
  const reservationId = crypto.randomUUID();

  beforeAll(async () => {
    // 1. Create User
    await dbPool.query(
      `INSERT INTO users (id, name, email, password_hash, role)
       VALUES ($1, 'Redis Recovery User', $2, 'hashed_pw', 'buyer');`,
      [userId, `redis_rec.${Date.now()}@example.com`]
    );

    // 2. Create Venue & Seats
    await dbPool.query(
      `INSERT INTO venues (id, name, address, city, state, country)
       VALUES ($1, 'Redis Resilience Center', '200 Cache Way', 'Bengaluru', 'KA', 'India');`,
      [venueId]
    );

    await dbPool.query(
      `INSERT INTO venue_seats (id, venue_id, section, row_label, seat_number, seat_type)
       VALUES 
        ($1, $2, 'Stalls', 'R', '1', 'Standard'),
        ($3, $2, 'Stalls', 'R', '2', 'Standard');`,
      [venueSeatId1, venueId, venueSeatId2]
    );

    // 3. Create Event & Session
    await dbPool.query(
      `INSERT INTO events (id, title, description, category, status)
       VALUES ($1, 'Cache Breakdown Symposium', 'Distributed Recovery', 'Tech', 'PUBLISHED');`,
      [eventId]
    );

    const startsAt = new Date(Date.now() + 86400000);
    const endsAt = new Date(Date.now() + 90000000);
    await dbPool.query(
      `INSERT INTO event_sessions (id, event_id, venue_id, starts_at, ends_at, status)
       VALUES ($1, $2, $3, $4, $5, 'OPEN');`,
      [sessionId, eventId, venueId, startsAt, endsAt]
    );

    // 4. Create Session Seats in PostgreSQL: Seat 1 is HELD by active reservation, Seat 2 is AVAILABLE
    const futureExpiresAt = new Date(Date.now() + 600000);
    await dbPool.query(
      `INSERT INTO reservations (id, user_id, event_session_id, status, expires_at, total_amount_minor, currency, idempotency_key)
       VALUES ($1, $2, $3, 'PENDING', $4, 75000, 'INR', $5);`,
      [reservationId, userId, sessionId, futureExpiresAt, `idemp_redis_rec_${Date.now()}`]
    );

    await dbPool.query(
      `INSERT INTO session_seats (id, event_session_id, venue_id, venue_seat_id, status, price_minor, current_reservation_id, hold_expires_at)
       VALUES 
        ($1, $2, $3, $4, 'HELD', 75000, $5, $6),
        ($7, $2, $3, $8, 'AVAILABLE', 75000, NULL, NULL);`,
      [sessionSeatId1, sessionId, venueId, venueSeatId1, reservationId, futureExpiresAt, sessionSeatId2, venueSeatId2]
    );

    await dbPool.query(
      `INSERT INTO reservation_items (reservation_id, event_session_id, session_seat_id, unit_price_minor)
       VALUES ($1, $2, $3, 75000);`,
      [reservationId, sessionId, sessionSeatId1]
    );
  });

  afterEach(() => {
    failureInjector.reset();
  });

  it('reconstitutes complete Redis session inventory from PostgreSQL after cache loss', async () => {
    const redis = await getRedisClient();

    // 1. Wipe Redis keys for this session (simulating total cache flush / loss)
    await inventoryService.clearSession(sessionId);

    // Verify Redis has no record of the session seats
    const emptyStatuses = await inventoryService.getSeatStatuses(sessionId);
    expect(emptyStatuses.size).toBe(0);

    // 2. Execute Reconstitution from PostgreSQL
    const report = await inventoryService.reconstructSessionInventory(sessionId);
    expect(report.restoredSeats).toBe(2);
    expect(report.restoredReservations).toBe(1);

    // 3. Verify Redis seats have been restored
    const restoredStatuses = await inventoryService.getSeatStatuses(sessionId);
    expect(restoredStatuses.get(sessionSeatId1)).toBe('HELD');
    expect(restoredStatuses.get(sessionSeatId2)).toBe('AVAILABLE');

    // 4. Verify reservation metadata restored
    const restoredRes = await inventoryService.getReservation(sessionId, reservationId);
    expect(restoredRes).not.toBeNull();
    expect(restoredRes?.id).toBe(reservationId);
    expect(restoredRes?.userId).toBe(userId);
    expect(restoredRes?.seats).toContain(sessionSeatId1);

    // 5. Verify expiration score restored in sorted set
    const expScore = await redis.zscore(RedisKeys.reservationExpirations(sessionId), reservationId);
    expect(Number(expScore)).toBeGreaterThan(Date.now());
  });

  it('prevents stale expiry release from overwriting a confirmed seat', async () => {
    // Confirm the reservation in Redis
    const confirmRes = await inventoryService.confirmSeats({
      sessionId,
      reservationId,
      userId,
    });
    expect(confirmRes.success).toBe(true);

    const seatStatusesAfterConfirm = await inventoryService.getSeatStatuses(sessionId, [sessionSeatId1]);
    expect(seatStatusesAfterConfirm.get(sessionSeatId1)).toBe('BOOKED');

    // Attempt stale expiry release on the already-confirmed reservation
    const releaseRes = await inventoryService.releaseSeats({
      sessionId,
      reservationId,
      userId,
      reason: 'EXPIRED',
    });

    // Lua script must reject releasing a confirmed seat
    expect(releaseRes.success).toBe(false);
    expect(releaseRes.error).toBe('RESERVATION_ALREADY_CONFIRMED');

    // Seat status MUST remain BOOKED
    const finalStatuses = await inventoryService.getSeatStatuses(sessionId, [sessionSeatId1]);
    expect(finalStatuses.get(sessionSeatId1)).toBe('BOOKED');
  });

  it('executes retry with exponential backoff and recovers from transient failures', async () => {
    let attempts = 0;
    const transientTask = async (): Promise<string> => {
      attempts++;
      if (attempts < 3) {
        throw new Error('TRANSIENT_REDIS_NETWORK_BLIP');
      }
      return 'SUCCESSFUL_EXECUTION';
    };

    const result = await inventoryService.executeWithRetry(transientTask, 4, 20);
    expect(result).toBe('SUCCESSFUL_EXECUTION');
    expect(attempts).toBe(3);
  });

  it('injects deterministic REDIS_HOLD_FAILURE and aborts cleanly', async () => {
    failureInjector.inject({
      point: 'REDIS_HOLD_FAILURE',
      times: 1,
    });

    let thrownError: Error | null = null;
    try {
      await inventoryService.holdSeats({
        sessionId,
        reservationId: crypto.randomUUID(),
        userId,
        seatIds: [sessionSeatId2],
        idempotencyKey: 'idemp_fail_test',
      });
    } catch (e: any) {
      thrownError = e;
    }

    expect(thrownError).toBeDefined();
    expect(thrownError?.message).toContain('[SIMULATED_FAILURE]');

    // Verify seat remained AVAILABLE after injected failure
    const status = await inventoryService.getSeatStatuses(sessionId, [sessionSeatId2]);
    expect(status.get(sessionSeatId2)).toBe('AVAILABLE');
  });
});
