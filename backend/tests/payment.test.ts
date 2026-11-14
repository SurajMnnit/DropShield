import request from 'supertest';
import crypto from 'crypto';
import { createApp } from '../src/app.js';
import { dbPool } from '../src/config/database.js';
import { RedisInventoryService } from '../src/services/inventory.service.js';
import { DevPaymentProvider } from '../src/services/payment/dev-payment.provider.js';

const app = createApp();
const inventoryService = new RedisInventoryService();

describe('Phase 6: Payment Lifecycle & Bookings Test Suite', () => {
  const userId = crypto.randomUUID();
  const eventId = crypto.randomUUID();
  const venueId = crypto.randomUUID();
  const sessionId = crypto.randomUUID();
  const venueSeatId = crypto.randomUUID();
  const sessionSeatId = crypto.randomUUID();
  const reservationId = crypto.randomUUID();

  const testEmail = `paytest.${Date.now()}@example.com`;

  beforeAll(async () => {
    // 1. Create User
    await dbPool.query(
      `INSERT INTO users (id, name, email, password_hash, role)
       VALUES ($1, 'Payment Tester', $2, 'hashed_pw', 'buyer');`,
      [userId, testEmail]
    );

    // 2. Create Venue & Seat
    await dbPool.query(
      `INSERT INTO venues (id, name, address, city, state, country)
       VALUES ($1, 'Payment Arena', '456 Stadium Rd', 'Bengaluru', 'Karnataka', 'India');`,
      [venueId]
    );
    await dbPool.query(
      `INSERT INTO venue_seats (id, venue_id, section, row_label, seat_number, seat_type)
       VALUES ($1, $2, 'VIP', 'A', '10', 'VIP');`,
      [venueSeatId, venueId]
    );

    // 3. Create Event & Session
    await dbPool.query(
      `INSERT INTO events (id, title, description, category, status)
       VALUES ($1, 'Symphony Gala', 'Orchestral performance', 'Classical', 'PUBLISHED');`,
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
       VALUES ($1, $2, $3, $4, 'AVAILABLE', 75000);`,
      [sessionSeatId, sessionId, venueId, venueSeatId]
    );

    // 5. Initialize Redis inventory
    await inventoryService.initializeSession(sessionId, [
      { seatId: sessionSeatId, status: 'AVAILABLE' },
    ]);

    // 6. Create active PENDING reservation
    const expiresAt = new Date(Date.now() + 600000);
    await inventoryService.holdSeats({
      sessionId,
      reservationId,
      userId,
      seatIds: [sessionSeatId],
      idempotencyKey: 'idemp_pay_test_01',
      holdTtlSeconds: 600,
    });

    await dbPool.query(
      `INSERT INTO reservations (id, user_id, event_session_id, status, expires_at, total_amount_minor, currency, idempotency_key)
       VALUES ($1, $2, $3, 'PENDING', $4, 75000, 'INR', 'idemp_pay_test_01');`,
      [reservationId, userId, sessionId, expiresAt]
    );

    await dbPool.query(
      `INSERT INTO reservation_items (reservation_id, event_session_id, session_seat_id, unit_price_minor)
       VALUES ($1, $2, $3, 75000);`,
      [reservationId, sessionId, sessionSeatId]
    );

    await dbPool.query(
      `UPDATE session_seats
       SET status = 'HELD', current_reservation_id = $1, hold_expires_at = $2
       WHERE id = $3;`,
      [reservationId, expiresAt, sessionSeatId]
    );
  });

  afterAll(async () => {
    // Note: transaction_ledger rows are immutable and permanently retained.
    // Clean up test data that has no immutable foreign key restrictions.
  });

  let confirmedBookingId: string;
  let mockProviderPaymentId: string;

  it('POST /api/v1/reservations/:id/payments initializes payment intent', async () => {
    const res = await request(app)
      .post(`/api/v1/reservations/${reservationId}/payments`)
      .set('x-user-id', userId)
      .send({ idempotencyKey: 'idemp_key_12345' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.paymentId).toBeDefined();
    expect(res.body.data.amountMinor).toBe(75000);
    expect(res.body.data.status).toBe('PENDING');

    mockProviderPaymentId = res.body.data.providerPaymentId;
  });

  it('POST /api/v1/payments/webhook rejects invalid signature with 401', async () => {
    const payload = {
      event: 'payment.succeeded',
      data: {
        reservationId,
        userId,
        providerPaymentId: mockProviderPaymentId,
        amountMinor: 75000,
        currency: 'INR',
      },
    };

    const res = await request(app)
      .post('/api/v1/payments/webhook')
      .set('x-dropshield-signature', 'invalid_signature_hash')
      .send(payload);

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  it('POST /api/v1/payments/webhook with valid signature finalizes booking and writes to ledger', async () => {
    const payload = {
      event: 'payment.succeeded',
      data: {
        reservationId,
        userId,
        providerPaymentId: mockProviderPaymentId,
        amountMinor: 75000,
        currency: 'INR',
      },
    };

    const rawBody = JSON.stringify(payload);
    const signature = DevPaymentProvider.signPayload(rawBody);

    const res = await request(app)
      .post('/api/v1/payments/webhook')
      .set('Content-Type', 'application/json')
      .set('x-dropshield-signature', signature)
      .send(rawBody);

    expect(res.status).toBe(200);
    expect(res.body.received).toBe(true);

    // Verify booking in database
    const bookingRes = await dbPool.query(
      `SELECT id, status, total_amount_minor FROM bookings WHERE reservation_id = $1;`,
      [reservationId]
    );
    expect(bookingRes.rows.length).toBe(1);
    expect(bookingRes.rows[0].status).toBe('CONFIRMED');
    confirmedBookingId = bookingRes.rows[0].id;

    // Verify seat status updated to BOOKED
    const seatRes = await dbPool.query(
      `SELECT status, current_booking_id, current_reservation_id, hold_expires_at 
       FROM session_seats WHERE id = $1;`,
      [sessionSeatId]
    );
    expect(seatRes.rows[0].status).toBe('BOOKED');
    expect(seatRes.rows[0].current_booking_id).toBe(confirmedBookingId);
    expect(seatRes.rows[0].current_reservation_id).toBeNull();
    expect(seatRes.rows[0].hold_expires_at).toBeNull();

    // Verify Immutable Transaction Ledger Record
    const ledgerRes = await dbPool.query(
      `SELECT * FROM transaction_ledger WHERE booking_id = $1 AND transaction_type = 'CHARGE';`,
      [confirmedBookingId]
    );
    expect(ledgerRes.rows.length).toBe(1);
    expect(Number(ledgerRes.rows[0].amount_minor)).toBe(75000);
    expect(ledgerRes.rows[0].reference).toContain(mockProviderPaymentId);
  });

  it('GET /api/v1/bookings lists user bookings', async () => {
    const res = await request(app)
      .get('/api/v1/bookings')
      .set('x-user-id', userId);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBeGreaterThanOrEqual(1);
    expect(res.body.data[0].id).toBe(confirmedBookingId);
    expect(res.body.data[0].status).toBe('CONFIRMED');
  });

  it('GET /api/v1/bookings/:id returns booking details with seat and payment info', async () => {
    const res = await request(app)
      .get(`/api/v1/bookings/${confirmedBookingId}`)
      .set('x-user-id', userId);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.id).toBe(confirmedBookingId);
    expect(res.body.data.items.length).toBe(1);
    expect(res.body.data.items[0].section).toBe('VIP');
    expect(res.body.data.items[0].seatNumber).toBe('10');
    expect(res.body.data.payment.status).toBe('SUCCEEDED');
  });

  it('POST /api/v1/bookings/:id/refund refunds booking and records ledger entry', async () => {
    const res = await request(app)
      .post(`/api/v1/bookings/${confirmedBookingId}/refund`)
      .set('x-user-id', userId)
      .send({ reason: 'Customer requested cancellation' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.status).toBe('REFUNDED');

    // Verify DB booking status
    const bCheck = await dbPool.query(`SELECT status FROM bookings WHERE id = $1;`, [confirmedBookingId]);
    expect(bCheck.rows[0].status).toBe('REFUNDED');

    // Verify Immutable Transaction Ledger REFUND entry
    const ledgerRes = await dbPool.query(
      `SELECT * FROM transaction_ledger WHERE booking_id = $1 AND transaction_type = 'REFUND';`,
      [confirmedBookingId]
    );
    expect(ledgerRes.rows.length).toBe(1);
    expect(Number(ledgerRes.rows[0].amount_minor)).toBe(75000);
  });
});
