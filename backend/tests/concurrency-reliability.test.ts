import crypto from 'crypto';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { dbPool } from '../src/config/database.js';
import { RedisInventoryService } from '../src/services/inventory.service.js';
import { DevPaymentProvider } from '../src/services/payment/dev-payment.provider.js';

describe('Phase 7: Concurrency & Stress Reliability Test Suite', () => {
  const app = createApp();
  const inventoryService = new RedisInventoryService();

  const venueId = crypto.randomUUID();
  const eventId = crypto.randomUUID();
  const sessionId = crypto.randomUUID();
  const venueSeatId = crypto.randomUUID();
  const sessionSeatId = crypto.randomUUID();

  beforeAll(async () => {
    // 1. Create Venue & Single Highly Contested Seat
    await dbPool.query(
      `INSERT INTO venues (id, name, address, city, state, country)
       VALUES ($1, 'High Contention Arena', '500 Race Track', 'Bengaluru', 'KA', 'India');`,
      [venueId]
    );

    await dbPool.query(
      `INSERT INTO venue_seats (id, venue_id, section, row_label, seat_number, seat_type)
       VALUES ($1, $2, 'FrontRow', 'A', '1', 'VIP');`,
      [venueSeatId, venueId]
    );

    // 2. Create Event & Session
    await dbPool.query(
      `INSERT INTO events (id, title, description, category, status)
       VALUES ($1, 'Flash Sale World Tour', 'Extreme Concurrency Test', 'Music', 'PUBLISHED');`,
      [eventId]
    );

    const startsAt = new Date(Date.now() + 86400000);
    const endsAt = new Date(Date.now() + 90000000);
    await dbPool.query(
      `INSERT INTO event_sessions (id, event_id, venue_id, starts_at, ends_at, status)
       VALUES ($1, $2, $3, $4, $5, 'OPEN');`,
      [sessionId, eventId, venueId, startsAt, endsAt]
    );

    // 3. Create Session Seat in DB
    await dbPool.query(
      `INSERT INTO session_seats (id, event_session_id, venue_id, venue_seat_id, status, price_minor)
       VALUES ($1, $2, $3, $4, 'AVAILABLE', 100000);`,
      [sessionSeatId, sessionId, venueId, venueSeatId]
    );

    // 4. Initialize in Redis
    await inventoryService.initializeSession(sessionId, [
      { seatId: sessionSeatId, status: 'AVAILABLE' },
    ]);
  });

  it('guarantees zero double-allocation when 10 concurrent requests race for the same seat', async () => {
    const concurrentUsers = 10;
    const holdPromises: Promise<any>[] = [];

    for (let i = 0; i < concurrentUsers; i++) {
      const uId = crypto.randomUUID();
      const resId = crypto.randomUUID();
      const idempKey = `idemp_race_${i}_${Date.now()}`;

      holdPromises.push(
        inventoryService.holdSeats({
          sessionId,
          userId: uId,
          reservationId: resId,
          seatIds: [sessionSeatId],
          idempotencyKey: idempKey,
          holdTtlSeconds: 300,
        })
      );
    }

    const results = await Promise.all(holdPromises);

    const successfulHolds = results.filter((r) => r.success === true);
    const failedHolds = results.filter((r) => r.success === false);

    // Exactly one reservation must win the hold
    expect(successfulHolds.length).toBe(1);
    expect(failedHolds.length).toBe(concurrentUsers - 1);

    // All failed holds must report conflict
    for (const fail of failedHolds) {
      expect(['SEAT_ALREADY_HELD', 'SEAT_NOT_AVAILABLE', 'SEAT_ALREADY_BOOKED', 'SEAT_UNAVAILABLE']).toContain(fail.error);
    }

    // Verify Redis seat is marked HELD
    const statusMap = await inventoryService.getSeatStatuses(sessionId, [sessionSeatId]);
    expect(statusMap.get(sessionSeatId)).toBe('HELD');
  });

  it('handles 5 concurrent webhook calls for the same reservation safely without duplicate bookings', async () => {
    const raceResId = crypto.randomUUID();
    const raceUserId = crypto.randomUUID();
    const futureExpiresAt = new Date(Date.now() + 600000);
    const providerPaymentId = `mock_pay_race_${crypto.randomUUID()}`;

    // Create user
    await dbPool.query(
      `INSERT INTO users (id, name, email, password_hash, role)
       VALUES ($1, 'Webhook Race User', $2, 'hashed_pw', 'buyer');`,
      [raceUserId, `race_user_${Date.now()}@example.com`]
    );

    // Create session seat 2
    const seatId2 = crypto.randomUUID();
    const venueSeatId2 = crypto.randomUUID();
    await dbPool.query(
      `INSERT INTO venue_seats (id, venue_id, section, row_label, seat_number, seat_type)
       VALUES ($1, $2, 'FrontRow', 'A', '2', 'VIP');`,
      [venueSeatId2, venueId]
    );

    await dbPool.query(
      `INSERT INTO session_seats (id, event_session_id, venue_id, venue_seat_id, status, price_minor)
       VALUES ($1, $2, $3, $4, 'AVAILABLE', 100000);`,
      [seatId2, sessionId, venueId, venueSeatId2]
    );

    await inventoryService.initializeSession(sessionId, [{ seatId: seatId2, status: 'AVAILABLE' }]);

    // Seed reservation
    await dbPool.query(
      `INSERT INTO reservations (id, user_id, event_session_id, status, expires_at, total_amount_minor, currency, idempotency_key)
       VALUES ($1, $2, $3, 'PENDING', $4, 100000, 'INR', $5);`,
      [raceResId, raceUserId, sessionId, futureExpiresAt, `idemp_webhook_race_${Date.now()}`]
    );

    await dbPool.query(
      `INSERT INTO reservation_items (reservation_id, event_session_id, session_seat_id, unit_price_minor)
       VALUES ($1, $2, $3, 100000);`,
      [raceResId, sessionId, seatId2]
    );

    await dbPool.query(
      `UPDATE session_seats
       SET status = 'HELD', current_reservation_id = $1, hold_expires_at = $2
       WHERE id = $3;`,
      [raceResId, futureExpiresAt, seatId2]
    );

    const webhookBody = {
      event: 'payment.succeeded',
      data: {
        reservationId: raceResId,
        userId: raceUserId,
        providerPaymentId,
        amountMinor: 100000,
        currency: 'INR',
      },
    };

    const rawBody = JSON.stringify(webhookBody);
    const signature = DevPaymentProvider.signPayload(rawBody);

    // Fire 5 concurrent webhook calls
    const webhookCalls = Array.from({ length: 5 }).map(() =>
      request(app)
        .post('/api/v1/payments/webhook')
        .set('x-dropshield-signature', signature)
        .set('Content-Type', 'application/json')
        .send(rawBody)
    );

    const responses = await Promise.all(webhookCalls);

    // All should succeed (200) either by winning or idempotently returning
    for (const res of responses) {
      expect(res.status).toBe(200);
      expect(res.body.received).toBe(true);
    }

    // Exactly one booking created in DB
    const bookings = await dbPool.query(
      `SELECT id FROM bookings WHERE reservation_id = $1;`,
      [raceResId]
    );
    expect(bookings.rows.length).toBe(1);

    // Exactly one payment created
    const payments = await dbPool.query(
      `SELECT id FROM payments WHERE booking_id = $1;`,
      [bookings.rows[0].id]
    );
    expect(payments.rows.length).toBe(1);

    // Exactly one immutable ledger entry created
    const ledger = await dbPool.query(
      `SELECT id FROM transaction_ledger WHERE booking_id = $1;`,
      [bookings.rows[0].id]
    );
    expect(ledger.rows.length).toBe(1);
  });
});
