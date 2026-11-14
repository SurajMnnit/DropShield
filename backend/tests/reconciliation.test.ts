import crypto from 'crypto';
import { dbPool } from '../src/config/database.js';
import { getRedisClient } from '../src/config/redis.js';
import { RedisKeys } from '../src/redis/keys.js';
import { RedisInventoryService } from '../src/services/inventory.service.js';
import { ReconciliationService } from '../src/services/reconciliation.service.js';

describe('Phase 7: Reconciliation Service Test Suite', () => {
  const reconciliationService = new ReconciliationService();
  const inventoryService = new RedisInventoryService();

  const userId = crypto.randomUUID();
  const venueId = crypto.randomUUID();
  const eventId = crypto.randomUUID();
  const sessionId = crypto.randomUUID();
  const venueSeatId1 = crypto.randomUUID();
  const venueSeatId2 = crypto.randomUUID();
  const sessionSeatId1 = crypto.randomUUID();
  const sessionSeatId2 = crypto.randomUUID();

  beforeAll(async () => {
    // 1. Create Base User
    await dbPool.query(
      `INSERT INTO users (id, name, email, password_hash, role)
       VALUES ($1, 'Reconcile Tester', $2, 'hashed_pw', 'buyer');`,
      [userId, `recon.${Date.now()}@test.com`]
    );

    // 2. Create Venue & Seats
    await dbPool.query(
      `INSERT INTO venues (id, name, address, city, state, country)
       VALUES ($1, 'Reconciliation Hall', '100 Sync Blvd', 'Bengaluru', 'Karnataka', 'India');`,
      [venueId]
    );

    await dbPool.query(
      `INSERT INTO venue_seats (id, venue_id, section, row_label, seat_number, seat_type)
       VALUES 
        ($1, $2, 'Balcony', 'A', '1', 'Standard'),
        ($3, $2, 'Balcony', 'A', '2', 'Standard');`,
      [venueSeatId1, venueId, venueSeatId2]
    );

    // 3. Create Event & Session
    await dbPool.query(
      `INSERT INTO events (id, title, description, category, status)
       VALUES ($1, 'Sync Summit', 'Reliability Conference', 'Tech', 'PUBLISHED');`,
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
        ($1, $2, $3, $4, 'AVAILABLE', 50000),
        ($5, $2, $3, $6, 'AVAILABLE', 50000);`,
      [sessionSeatId1, sessionId, venueId, venueSeatId1, sessionSeatId2, venueSeatId2]
    );

    await inventoryService.initializeSession(sessionId, [
      { seatId: sessionSeatId1, status: 'AVAILABLE' },
      { seatId: sessionSeatId2, status: 'AVAILABLE' },
    ]);
  });

  it('detects and leaves database unmodified in dryRun mode', async () => {
    const expiredResId = crypto.randomUUID();
    const pastExpiresAt = new Date(Date.now() - 60000);

    await dbPool.query(
      `INSERT INTO reservations (id, user_id, event_session_id, status, expires_at, total_amount_minor, currency, idempotency_key)
       VALUES ($1, $2, $3, 'PENDING', $4, 50000, 'INR', $5);`,
      [expiredResId, userId, sessionId, pastExpiresAt, `idemp_recon_dry_${Date.now()}`]
    );

    await dbPool.query(
      `UPDATE session_seats
       SET status = 'HELD', current_reservation_id = $1, hold_expires_at = $2
       WHERE id = $3;`,
      [expiredResId, pastExpiresAt, sessionSeatId1]
    );

    // Run Dry Run
    const dryReport = await reconciliationService.runReconciliation({ dryRun: true });
    expect(dryReport.dryRun).toBe(true);

    const found = dryReport.discrepancies.find((d) => d.entityId === expiredResId);
    expect(found).toBeDefined();
    expect(found?.type).toBe('EXPIRED_RESERVATION_STUCK');
    expect(found?.repaired).toBe(false);

    // Verify DB was NOT updated
    const dbCheck = await dbPool.query(
      `SELECT status FROM reservations WHERE id = $1;`,
      [expiredResId]
    );
    expect(dbCheck.rows[0].status).toBe('PENDING');
  });

  it('repairs stuck expired reservations and frees held seats in active run', async () => {
    // Run active reconciliation
    const activeReport = await reconciliationService.runReconciliation({ dryRun: false });
    expect(activeReport.dryRun).toBe(false);

    const repaired = activeReport.discrepancies.filter((d) => d.type === 'EXPIRED_RESERVATION_STUCK' && d.repaired);
    expect(repaired.length).toBeGreaterThan(0);

    // Verify seat is back to AVAILABLE
    const seatCheck = await dbPool.query(
      `SELECT status, current_reservation_id FROM session_seats WHERE id = $1;`,
      [sessionSeatId1]
    );
    expect(seatCheck.rows[0].status).toBe('AVAILABLE');
    expect(seatCheck.rows[0].current_reservation_id).toBeNull();
  });

  it('detects and recovers stuck outbox events locked by a crashed process', async () => {
    const eventId = crypto.randomUUID();
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);

    await dbPool.query(
      `INSERT INTO outbox_events (id, aggregate_type, aggregate_id, event_type, payload, status, locked_at, locked_by)
       VALUES ($1, 'Reservation', $2, 'booking.requested', '{}', 'PROCESSING', $3, 'crashed-worker-99');`,
      [eventId, crypto.randomUUID(), tenMinutesAgo]
    );

    const report = await reconciliationService.runReconciliation({ dryRun: false, outboxStaleMinutes: 5 });
    const outboxDiscrepancy = report.discrepancies.find((d) => d.entityId === eventId);

    expect(outboxDiscrepancy).toBeDefined();
    expect(outboxDiscrepancy?.type).toBe('STUCK_OUTBOX_EVENT');
    expect(outboxDiscrepancy?.repaired).toBe(true);

    // Check DB status reset to PENDING
    const obCheck = await dbPool.query(`SELECT status, locked_at, locked_by FROM outbox_events WHERE id = $1;`, [eventId]);
    expect(obCheck.rows[0].status).toBe('PENDING');
    expect(obCheck.rows[0].locked_at).toBeNull();
    expect(obCheck.rows[0].locked_by).toBeNull();
  });

  it('reconciles Redis cache when PostgreSQL session_seats is BOOKED but Redis is out of sync', async () => {
    const mockBookingId = crypto.randomUUID();
    const mockResId = crypto.randomUUID();

    // Create valid booking for session_seats state integrity
    await dbPool.query(
      `INSERT INTO reservations (id, user_id, event_session_id, status, expires_at, total_amount_minor, currency, idempotency_key)
       VALUES ($1, $2, $3, 'CONFIRMED', CURRENT_TIMESTAMP + INTERVAL '1 hour', 50000, 'INR', $4);`,
      [mockResId, userId, sessionId, `idemp_sync_bk_${Date.now()}`]
    );

    await dbPool.query(
      `INSERT INTO bookings (id, reservation_id, user_id, event_session_id, status, total_amount_minor, currency, confirmed_at)
       VALUES ($1, $2, $3, $4, 'CONFIRMED', 50000, 'INR', CURRENT_TIMESTAMP);`,
      [mockBookingId, mockResId, userId, sessionId]
    );

    // Mark seat in PostgreSQL as BOOKED with valid booking reference
    await dbPool.query(
      `UPDATE session_seats SET status = 'BOOKED', current_booking_id = $1, current_reservation_id = NULL, hold_expires_at = NULL WHERE id = $2;`,
      [mockBookingId, sessionSeatId2]
    );

    // Ensure Redis has it as AVAILABLE
    const redis = await getRedisClient();
    await redis.hset(RedisKeys.sessionSeats(sessionId), sessionSeatId2, 'AVAILABLE');

    const report = await reconciliationService.runReconciliation({ dryRun: false, sessionIds: [sessionId] });
    const driftItem = report.discrepancies.find((d) => d.entityId === sessionSeatId2 && d.type === 'POSTGRES_BOOKED_MISSING_REDIS');

    expect(driftItem).toBeDefined();
    expect(driftItem?.repaired).toBe(true);

    // Verify Redis is now updated to BOOKED
    const redisStatus = await redis.hget(RedisKeys.sessionSeats(sessionId), sessionSeatId2);
    expect(redisStatus).toBe('BOOKED');
  });

  it('reconciles orphan Redis BOOKED seats back to AVAILABLE when PostgreSQL is AVAILABLE', async () => {
    // PostgreSQL is AVAILABLE for sessionSeatId1
    await dbPool.query(
      `UPDATE session_seats SET status = 'AVAILABLE', current_reservation_id = NULL, current_booking_id = NULL WHERE id = $1;`,
      [sessionSeatId1]
    );

    // Redis erroneously has BOOKED
    const redis = await getRedisClient();
    await redis.hset(RedisKeys.sessionSeats(sessionId), sessionSeatId1, 'BOOKED');

    const report = await reconciliationService.runReconciliation({ dryRun: false, sessionIds: [sessionId] });
    const orphanItem = report.discrepancies.find((d) => d.entityId === sessionSeatId1 && d.type === 'REDIS_ORPHAN_BOOKED');

    expect(orphanItem).toBeDefined();
    expect(orphanItem?.repaired).toBe(true);

    // Verify Redis is reconciled to AVAILABLE
    const redisStatus = await redis.hget(RedisKeys.sessionSeats(sessionId), sessionSeatId1);
    expect(redisStatus).toBe('AVAILABLE');
  });

  it('appends missing immutable audit record to transaction_ledger', async () => {
    const bookingId = crypto.randomUUID();
    const paymentId = crypto.randomUUID();
    const mockResId = crypto.randomUUID();

    // Insert dummy reservation and confirmed booking
    await dbPool.query(
      `INSERT INTO reservations (id, user_id, event_session_id, status, expires_at, total_amount_minor, currency, idempotency_key)
       VALUES ($1, $2, $3, 'CONFIRMED', CURRENT_TIMESTAMP + INTERVAL '1 hour', 50000, 'INR', $4);`,
      [mockResId, userId, sessionId, `idemp_recon_ledger_${Date.now()}`]
    );

    await dbPool.query(
      `INSERT INTO bookings (id, reservation_id, user_id, event_session_id, status, total_amount_minor, currency, confirmed_at)
       VALUES ($1, $2, $3, $4, 'CONFIRMED', 50000, 'INR', CURRENT_TIMESTAMP);`,
      [bookingId, mockResId, userId, sessionId]
    );

    const provPayId = `mock_pay_rec_${crypto.randomUUID()}`;
    await dbPool.query(
      `INSERT INTO payments (id, booking_id, user_id, amount_minor, currency, provider, provider_payment_id, idempotency_key, status)
       VALUES ($1, $2, $3, 50000, 'INR', 'DEV_MOCK_GATEWAY', $4, $5, 'SUCCEEDED');`,
      [paymentId, bookingId, userId, provPayId, `idemp_pay_rec_${crypto.randomUUID()}`]
    );

    // Intentionally omit transaction_ledger entry to simulate an uncommitted ledger write
    const report = await reconciliationService.runReconciliation({ dryRun: false });
    const ledgerDiscrepancy = report.discrepancies.find(
      (d) => d.entityId === paymentId && d.type === 'MISSING_LEDGER_RECORD'
    );

    expect(ledgerDiscrepancy).toBeDefined();
    expect(ledgerDiscrepancy?.repaired).toBe(true);

    // Verify transaction_ledger has been appended with immutable record
    const ledgerCheck = await dbPool.query(
      `SELECT * FROM transaction_ledger WHERE payment_id = $1 AND transaction_type = 'CHARGE';`,
      [paymentId]
    );
    expect(ledgerCheck.rows.length).toBe(1);
    expect(Number(ledgerCheck.rows[0].amount_minor)).toBe(50000);
  });

  it('gracefully aborts when another instance holds the PostgreSQL advisory lock', async () => {
    const client = await dbPool.connect();
    try {
      await client.query('BEGIN');
      // Hold the advisory lock explicitly in another transaction
      const lockRes = await client.query(`SELECT pg_try_advisory_xact_lock(740001);`);
      expect(lockRes.rows[0].pg_try_advisory_xact_lock).toBe(true);

      // Attempt to run reconciliation in another transaction
      const busyReport = await reconciliationService.runReconciliation();
      expect(busyReport.totalDetected).toBe(0);
      expect(busyReport.discrepancies[0].entityId).toBe('LOCK');

      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });
});
