// Modified for strict test DB isolation
import pg from 'pg';
import { env } from '../src/config/env.js';
import { assertTestDatabaseUrl } from '../src/config/database.js';

function createTestClient(): pg.Client {
  const connectionUrl = process.env.TEST_DATABASE_URL;
  assertTestDatabaseUrl(connectionUrl);
  const needsSsl = connectionUrl!.includes('sslmode=require') ||
    connectionUrl!.includes('neon.tech') ||
    env.NODE_ENV === 'production';

  return new pg.Client({
    connectionString: connectionUrl,
    ssl: needsSsl ? { rejectUnauthorized: true } : false,
    connectionTimeoutMillis: 15000,
  });
}

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MIGRATIONS_DIR = path.resolve(__dirname, '../../database/migrations');

// Test client is defined at the top of the file with strict TEST_DATABASE_URL enforcement.


describe('DropShield Phase 3: Final Comprehensive Database Integrity Suite', () => {
  let client: pg.Client;
  const TEST_SCHEMA = 'test_phase3_validation';

  beforeAll(async () => {
    client = createTestClient();
    await client.connect();

    // Verify connected database identity matches test constraints
    const dbCheck = await client.query('SELECT current_database() as db_name;');
    const currentDb = String(dbCheck.rows[0].db_name).toLowerCase();
    const rejectedNames = ['production', 'prod', 'dropshield', 'main', 'master', 'postgres'];
    if (rejectedNames.includes(currentDb) || !currentDb.includes('test')) {
      throw new Error(`CRITICAL: Connected database '${currentDb}' is not an authorized test database. Aborting.`);
    }

    // Isolated test schema
    await client.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE;`);
    await client.query(`CREATE SCHEMA ${TEST_SCHEMA};`);
    await client.query(`SET search_path TO ${TEST_SCHEMA}, public;`);
  }, 30000);

  afterAll(async () => {
    if (client) {
      try {
        await client.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE;`);
      } catch (err) {
        // cleanup ignore
      }
      await client.end();
    }
  });

  test('1. Migration clean install, rollback, and re-migration', async () => {
    const upSql = fs.readFileSync(path.join(MIGRATIONS_DIR, '001_initial_schema.up.sql'), 'utf8');
    const downSql = fs.readFileSync(path.join(MIGRATIONS_DIR, '001_initial_schema.down.sql'), 'utf8');

    // Run UP
    await client.query(upSql);
    let tableCheck = await client.query(`
      SELECT table_name FROM information_schema.tables WHERE table_schema = $1;
    `, [TEST_SCHEMA]);
    expect(tableCheck.rows.length).toBeGreaterThanOrEqual(14);

    // Run DOWN (verify rollback)
    await client.query(downSql);
    tableCheck = await client.query(`
      SELECT table_name FROM information_schema.tables WHERE table_schema = $1;
    `, [TEST_SCHEMA]);
    expect(tableCheck.rows.length).toBe(0);

    // Re-run UP
    await client.query(upSql);
  });

  test('2. Venue/Session Integrity: Rejects seat from Venue B associated with Session at Venue A', async () => {
    const vA = await client.query(`
      INSERT INTO venues (name, address, city, state, country)
      VALUES ('Venue Alpha', 'Street A', 'City A', 'State A', 'Country') RETURNING id;
    `);
    const venueAId = vA.rows[0].id;

    const vB = await client.query(`
      INSERT INTO venues (name, address, city, state, country)
      VALUES ('Venue Beta', 'Street B', 'City B', 'State B', 'Country') RETURNING id;
    `);
    const venueBId = vB.rows[0].id;

    const vsB = await client.query(`
      INSERT INTO venue_seats (venue_id, section, row_label, seat_number)
      VALUES ($1, 'SEC-B', 'R1', 'S1') RETURNING id;
    `, [venueBId]);
    const venueBSeatId = vsB.rows[0].id;

    const ev = await client.query(`
      INSERT INTO events (title, category) VALUES ('Festival Alpha', 'Concert') RETURNING id;
    `);
    const eventId = ev.rows[0].id;

    const sessA = await client.query(`
      INSERT INTO event_sessions (event_id, venue_id, starts_at, ends_at)
      VALUES ($1, $2, NOW() + INTERVAL '1 day', NOW() + INTERVAL '1 day 2 hours') RETURNING id;
    `, [eventId, venueAId]);
    const sessionAId = sessA.rows[0].id;

    // Reject associating seat from Venue B with Session at Venue A
    let venueMismatchFailed = false;
    try {
      await client.query(`
        INSERT INTO session_seats (event_session_id, venue_id, venue_seat_id, status, price_minor)
        VALUES ($1, $2, $3, 'AVAILABLE', 100000);
      `, [sessionAId, venueAId, venueBSeatId]);
    } catch (err: any) {
      venueMismatchFailed = true;
      expect(err.message).toMatch(/fk_session_seats_venue_seat|foreign key/i);
    }
    expect(venueMismatchFailed).toBe(true);
  });

  test('3. Cross-Session Seat Integrity: Seat cannot reference active reservation or booking from another session', async () => {
    const vRes = await client.query(`SELECT id FROM venues LIMIT 1;`);
    const venueId = vRes.rows[0].id;

    const vs1 = await client.query(`
      INSERT INTO venue_seats (venue_id, section, row_label, seat_number)
      VALUES ($1, 'SEC-SESS', 'R1', 'S1') RETURNING id;
    `, [venueId]);
    const venueSeat1 = vs1.rows[0].id;

    const vs2 = await client.query(`
      INSERT INTO venue_seats (venue_id, section, row_label, seat_number)
      VALUES ($1, 'SEC-SESS', 'R1', 'S2') RETURNING id;
    `, [venueId]);
    const venueSeat2 = vs2.rows[0].id;

    const ev = await client.query(`SELECT id FROM events LIMIT 1;`);
    const eventId = ev.rows[0].id;

    const s1 = await client.query(`
      INSERT INTO event_sessions (event_id, venue_id, starts_at, ends_at)
      VALUES ($1, $2, NOW() + INTERVAL '2 day', NOW() + INTERVAL '2 day 2 hours') RETURNING id;
    `, [eventId, venueId]);
    const session1Id = s1.rows[0].id;

    const s2 = await client.query(`
      INSERT INTO event_sessions (event_id, venue_id, starts_at, ends_at)
      VALUES ($1, $2, NOW() + INTERVAL '3 day', NOW() + INTERVAL '3 day 2 hours') RETURNING id;
    `, [eventId, venueId]);
    const session2Id = s2.rows[0].id;

    await client.query(`
      INSERT INTO session_seats (event_session_id, venue_id, venue_seat_id, status, price_minor)
      VALUES ($1, $2, $3, 'AVAILABLE', 100000);
    `, [session1Id, venueId, venueSeat1]);

    const ss2 = await client.query(`
      INSERT INTO session_seats (event_session_id, venue_id, venue_seat_id, status, price_minor)
      VALUES ($1, $2, $3, 'AVAILABLE', 100000) RETURNING id;
    `, [session2Id, venueId, venueSeat2]);
    const seatInSession2 = ss2.rows[0].id;

    // Create User & Reservation for Session 1
    const u = await client.query(`
      INSERT INTO users (name, email, password_hash, role)
      VALUES ('Buyer Cross', 'buyer.cross@test.internal', 'hash123', 'buyer') RETURNING id;
    `);
    const userId = u.rows[0].id;

    const r1 = await client.query(`
      INSERT INTO reservations (user_id, event_session_id, expires_at, total_amount_minor, idempotency_key)
      VALUES ($1, $2, NOW() + INTERVAL '10 min', 100000, 'res-cross-chk-1') RETURNING id;
    `, [userId, session1Id]);
    const reservation1Id = r1.rows[0].id;

    // 1. A seat in Session 2 CANNOT reference an active reservation from Session 1
    let seatCrossResFailed = false;
    try {
      await client.query(`
        UPDATE session_seats 
        SET status = 'HELD', current_reservation_id = $1, hold_expires_at = NOW() + INTERVAL '10 min'
        WHERE id = $2;
      `, [reservation1Id, seatInSession2]);
    } catch (err: any) {
      seatCrossResFailed = true;
      expect(err.message).toMatch(/fk_session_seats_active_reservation|foreign key/i);
    }
    expect(seatCrossResFailed).toBe(true);

    // Create booking for Session 1
    const bk1 = await client.query(`
      INSERT INTO bookings (reservation_id, user_id, event_session_id, total_amount_minor)
      VALUES ($1, $2, $3, 100000) RETURNING id;
    `, [reservation1Id, userId, session1Id]);
    const booking1Id = bk1.rows[0].id;

    // 2. A seat in Session 2 CANNOT reference an active booking from Session 1
    let seatCrossBkFailed = false;
    try {
      await client.query(`
        UPDATE session_seats 
        SET status = 'BOOKED', current_booking_id = $1, hold_expires_at = NULL
        WHERE id = $2;
      `, [booking1Id, seatInSession2]);
    } catch (err: any) {
      seatCrossBkFailed = true;
      expect(err.message).toMatch(/fk_session_seats_active_booking|foreign key/i);
    }
    expect(seatCrossBkFailed).toBe(true);

    // 3. reservation_items in Session 1 cannot link seat from Session 2
    let resItemCrossFailed = false;
    try {
      await client.query(`
        INSERT INTO reservation_items (reservation_id, event_session_id, session_seat_id, unit_price_minor)
        VALUES ($1, $2, $3, 100000);
      `, [reservation1Id, session1Id, seatInSession2]);
    } catch (err: any) {
      resItemCrossFailed = true;
      expect(err.message).toMatch(/fk_reservation_items_seat_session|foreign key/i);
    }
    expect(resItemCrossFailed).toBe(true);
  });

  test('4. Historical Data Preservation: Deleting event session with existing inventory is rejected (ON DELETE RESTRICT)', async () => {
    // Attempting to delete an event session that has inventory rows in session_seats
    const sessRow = await client.query(`
      SELECT event_session_id AS id FROM session_seats LIMIT 1;
    `);
    const activeSessionId = sessRow.rows[0].id;

    let deleteSessionBlocked = false;
    try {
      await client.query(`DELETE FROM event_sessions WHERE id = $1;`, [activeSessionId]);
    } catch (err: any) {
      deleteSessionBlocked = true;
      expect(err.message).toMatch(/foreign key|violates/i);
    }
    expect(deleteSessionBlocked).toBe(true);
  });

  test('5. Historical Data Preservation: Deleting venue with historical event sessions is rejected (ON DELETE RESTRICT)', async () => {
    // Attempting to delete a venue that has associated event_sessions
    const vRow = await client.query(`
      SELECT venue_id AS id FROM event_sessions LIMIT 1;
    `);
    const activeVenueId = vRow.rows[0].id;

    let deleteVenueBlocked = false;
    try {
      await client.query(`DELETE FROM venues WHERE id = $1;`, [activeVenueId]);
    } catch (err: any) {
      deleteVenueBlocked = true;
      expect(err.message).toMatch(/foreign key|violates/i);
    }
    expect(deleteVenueBlocked).toBe(true);
  });

  test('6. User Ownership Consistency (Cross-user booking or payment rejected)', async () => {
    const u1 = await client.query(`
      INSERT INTO users (name, email, password_hash, role)
      VALUES ('Alice Owner', 'alice.owner@test.internal', 'pass1', 'buyer') RETURNING id;
    `);
    const user1Id = u1.rows[0].id;

    const u2 = await client.query(`
      INSERT INTO users (name, email, password_hash, role)
      VALUES ('Bob Stranger', 'bob.stranger@test.internal', 'pass2', 'buyer') RETURNING id;
    `);
    const user2Id = u2.rows[0].id;

    const sess = await client.query(`SELECT id FROM event_sessions LIMIT 1;`);
    const sessionId = sess.rows[0].id;

    // Alice creates reservation
    const rAlice = await client.query(`
      INSERT INTO reservations (user_id, event_session_id, expires_at, total_amount_minor, idempotency_key)
      VALUES ($1, $2, NOW() + INTERVAL '10 min', 50000, 'res-alice-own') RETURNING id;
    `, [user1Id, sessionId]);
    const reservationAliceId = rAlice.rows[0].id;

    // Bob tries to confirm a booking using Alice's reservation
    let bobBookingFailed = false;
    try {
      await client.query(`
        INSERT INTO bookings (reservation_id, user_id, event_session_id, total_amount_minor)
        VALUES ($1, $2, $3, 50000);
      `, [reservationAliceId, user2Id, sessionId]);
    } catch (err: any) {
      bobBookingFailed = true;
      expect(err.message).toMatch(/fk_bookings_reservation_user_session|foreign key/i);
    }
    expect(bobBookingFailed).toBe(true);

    // Alice creates valid booking
    const bkAlice = await client.query(`
      INSERT INTO bookings (reservation_id, user_id, event_session_id, total_amount_minor)
      VALUES ($1, $2, $3, 50000) RETURNING id;
    `, [reservationAliceId, user1Id, sessionId]);
    const bookingAliceId = bkAlice.rows[0].id;

    // Bob tries to pay for Alice's booking
    let bobPaymentFailed = false;
    try {
      await client.query(`
        INSERT INTO payments (booking_id, user_id, amount_minor, provider, idempotency_key, status)
        VALUES ($1, $2, 50000, 'STRIPE', 'bob-pay-steal', 'PENDING');
      `, [bookingAliceId, user2Id]);
    } catch (err: any) {
      bobPaymentFailed = true;
      expect(err.message).toMatch(/fk_payments_booking_user|foreign key/i);
    }
    expect(bobPaymentFailed).toBe(true);
  });

  test('7. Payment Lifecycle & Refund Retry Behavior', async () => {
    const bk = await client.query(`SELECT id, user_id FROM bookings LIMIT 1;`);
    const bookingId = bk.rows[0].id;
    const userId = bk.rows[0].user_id;

    // Initial payment attempt succeeds
    const p1 = await client.query(`
      INSERT INTO payments (booking_id, user_id, amount_minor, provider, provider_payment_id, idempotency_key, status)
      VALUES ($1, $2, 50000, 'STRIPE', 'ch_stripe_initial_123', 'idemp-pay-1', 'SUCCEEDED')
      RETURNING id, status;
    `, [bookingId, userId]);
    const payment1Id = p1.rows[0].id;
    expect(p1.rows[0].status).toBe('SUCCEEDED');

    // Attempting a second concurrent SUCCEEDED payment on the same booking must be rejected
    let duplicateSucceededFailed = false;
    try {
      await client.query(`
        INSERT INTO payments (booking_id, user_id, amount_minor, provider, provider_payment_id, idempotency_key, status)
        VALUES ($1, $2, 50000, 'STRIPE', 'ch_stripe_second_456', 'idemp-pay-2', 'SUCCEEDED');
      `, [bookingId, userId]);
    } catch (err: any) {
      duplicateSucceededFailed = true;
      expect(err.message).toMatch(/uq_payments_booking_succeeded|duplicate key/i);
    }
    expect(duplicateSucceededFailed).toBe(true);

    // Initial payment is refunded
    await client.query(`UPDATE payments SET status = 'REFUNDED' WHERE id = $1;`, [payment1Id]);

    // Now, a subsequent re-payment attempt for this booking succeeds legitimately
    const pRetry = await client.query(`
      INSERT INTO payments (booking_id, user_id, amount_minor, provider, provider_payment_id, idempotency_key, status)
      VALUES ($1, $2, 50000, 'STRIPE', 'ch_stripe_retry_789', 'idemp-pay-retry-1', 'SUCCEEDED')
      RETURNING id, status;
    `, [bookingId, userId]);
    expect(pRetry.rows[0].status).toBe('SUCCEEDED');
  });

  test('8. Concurrency Integrity: Expiry recovery and payment confirmation cannot produce inconsistent inventory', async () => {
    // Setup a held seat with expired reservation
    const sess = await client.query(`SELECT id, venue_id FROM event_sessions LIMIT 1;`);
    const sessionId = sess.rows[0].id;
    const venueId = sess.rows[0].venue_id;

    const vs = await client.query(`
      INSERT INTO venue_seats (venue_id, section, row_label, seat_number)
      VALUES ($1, 'RACE-SEC', 'R9', 'S99') RETURNING id;
    `, [venueId]);
    const venueSeatId = vs.rows[0].id;

    const ss = await client.query(`
      INSERT INTO session_seats (event_session_id, venue_id, venue_seat_id, status, price_minor)
      VALUES ($1, $2, $3, 'AVAILABLE', 75000) RETURNING id;
    `, [sessionId, venueId, venueSeatId]);
    const raceSeatId = ss.rows[0].id;

    const u = await client.query(`SELECT id FROM users LIMIT 1;`);
    const userId = u.rows[0].id;

    const rExp = await client.query(`
      INSERT INTO reservations (user_id, event_session_id, expires_at, total_amount_minor, idempotency_key, status)
      VALUES ($1, $2, NOW() - INTERVAL '1 minute', 75000, 'race-exp-res', 'PENDING') RETURNING id;
    `, [userId, sessionId]);
    const expResId = rExp.rows[0].id;

    await client.query(`
      UPDATE session_seats 
      SET status = 'HELD', current_reservation_id = $1, hold_expires_at = NOW() - INTERVAL '1 minute'
      WHERE id = $2;
    `, [expResId, raceSeatId]);

    // Expiry worker executes atomic recovery sequence
    const expiryClient = createTestClient();
    await expiryClient.connect();
    await expiryClient.query(`SET search_path TO ${TEST_SCHEMA}, public;`);

    await expiryClient.query('BEGIN');
    const lockRes = await expiryClient.query(`
      SELECT id, status, expires_at FROM reservations WHERE id = $1 FOR UPDATE;
    `, [expResId]);
    expect(lockRes.rows[0].status).toBe('PENDING');

    await expiryClient.query(`
      SELECT id FROM session_seats WHERE current_reservation_id = $1 ORDER BY id ASC FOR UPDATE;
    `, [expResId]);

    await expiryClient.query(`UPDATE reservations SET status = 'EXPIRED' WHERE id = $1;`, [expResId]);
    await expiryClient.query(`
      UPDATE session_seats 
      SET status = 'AVAILABLE', current_reservation_id = NULL, hold_expires_at = NULL 
      WHERE current_reservation_id = $1;
    `, [expResId]);
    await expiryClient.query('COMMIT');
    await expiryClient.end();

    // Concurrent payment worker attempts confirmation on same reservation
    const paymentClient = createTestClient();
    await paymentClient.connect();
    await paymentClient.query(`SET search_path TO ${TEST_SCHEMA}, public;`);

    await paymentClient.query('BEGIN');
    const paymentLock = await paymentClient.query(`
      SELECT id, status FROM reservations WHERE id = $1 FOR UPDATE;
    `, [expResId]);

    // Must detect EXPIRED and abort confirmation
    expect(paymentLock.rows[0].status).toBe('EXPIRED');
    await paymentClient.query('ROLLBACK');
    await paymentClient.end();

    // Verify seat is cleanly available
    const seatCheck = await client.query(`SELECT status, current_reservation_id FROM session_seats WHERE id = $1;`, [raceSeatId]);
    expect(seatCheck.rows[0].status).toBe('AVAILABLE');
    expect(seatCheck.rows[0].current_reservation_id).toBeNull();
  });

  test('9. Outbox Crash Recovery: Stale PROCESSING outbox event is recovered safely', async () => {
    const staleTime = new Date(Date.now() - 10 * 60 * 1000);
    const evRes = await client.query(`
      INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, payload, status, attempts, locked_at, locked_by)
      VALUES ('BOOKING', 'bk-crash-test', 'BookingConfirmed', '{"seats": ["A1"]}', 'PROCESSING', 1, $1, 'dead-worker-pid-999')
      RETURNING id;
    `, [staleTime.toISOString()]);
    const eventId = evRes.rows[0].id;

    // Outbox relay sweeper reclaims stale event
    const sweepRes = await client.query(`
      UPDATE outbox_events
      SET 
        status = 'PENDING',
        locked_at = NULL,
        locked_by = NULL,
        last_error = 'Recovered from stale lock'
      WHERE status = 'PROCESSING' AND locked_at < NOW() - INTERVAL '5 minutes'
      RETURNING id, status, last_error;
    `);

    expect(sweepRes.rowCount).toBeGreaterThanOrEqual(1);
    const recovered = sweepRes.rows.find((r: { id: string }) => r.id === eventId);
    expect(recovered).toBeDefined();
    expect(recovered.status).toBe('PENDING');

    // Re-claimed by new active worker
    const claimRes = await client.query(`
      UPDATE outbox_events 
      SET status = 'PROCESSING', attempts = attempts + 1, locked_at = NOW(), locked_by = 'live-worker-pid-111'
      WHERE id = $1 AND status = 'PENDING'
      RETURNING id, status, attempts, locked_by;
    `, [eventId]);

    expect(claimRes.rows[0].status).toBe('PROCESSING');
    expect(claimRes.rows[0].attempts).toBe(2);
    expect(claimRes.rows[0].locked_by).toBe('live-worker-pid-111');
  });

  test('10. Ledger Security: Trigger prevents UPDATE, DELETE, and TRUNCATE', async () => {
    const bk = await client.query(`SELECT id FROM bookings LIMIT 1;`);
    const bookingId = bk.rows[0].id;

    const lRes = await client.query(`
      INSERT INTO transaction_ledger (booking_id, transaction_type, amount_minor, reference)
      VALUES ($1, 'CHARGE', 50000, 'REF-AUDIT-FINAL') RETURNING id;
    `, [bookingId]);
    const ledgerId = lRes.rows[0].id;

    let updateFailed = false;
    try {
      await client.query(`UPDATE transaction_ledger SET amount_minor = 100000 WHERE id = $1;`, [ledgerId]);
    } catch (err: any) {
      updateFailed = true;
      expect(err.message).toMatch(/strictly immutable/i);
    }
    expect(updateFailed).toBe(true);

    let deleteFailed = false;
    try {
      await client.query(`DELETE FROM transaction_ledger WHERE id = $1;`, [ledgerId]);
    } catch (err: any) {
      deleteFailed = true;
      expect(err.message).toMatch(/strictly immutable/i);
    }
    expect(deleteFailed).toBe(true);

    let truncateFailed = false;
    try {
      await client.query(`TRUNCATE TABLE transaction_ledger;`);
    } catch (err: any) {
      truncateFailed = true;
      expect(err.message).toMatch(/strictly immutable/i);
    }
    expect(truncateFailed).toBe(true);
  });
});
