import crypto from 'crypto';
import { closeRedisClient, checkRedisHealth } from '../src/config/redis.js';
import { RedisInventoryService } from '../src/services/inventory.service.js';
import { ReservationExpiryService } from '../src/services/inventory-expiry.service.js';

describe('DropShield Phase 4: Redis Atomic Inventory Engine', () => {
  let inventoryService: RedisInventoryService;
  let expiryService: ReservationExpiryService;
  const testSessionId = 'sess-test-' + crypto.randomUUID();

  beforeAll(async () => {
    inventoryService = new RedisInventoryService();
    expiryService = new ReservationExpiryService();

    // Verify Redis connection is operational
    const health = await checkRedisHealth();
    expect(health.status).toBe('up');

    // Pre-populate session seat inventory
    const seats = [
      { seatId: 'SEAT-A1' },
      { seatId: 'SEAT-A2' },
      { seatId: 'SEAT-A3' },
      { seatId: 'SEAT-A4' },
      { seatId: 'SEAT-B1' },
      { seatId: 'SEAT-B2' },
      { seatId: 'SEAT-B3' },
      { seatId: 'SEAT-B4' },
      { seatId: 'SEAT-EXP-1' },
      { seatId: 'SEAT-EXP-2' },
    ];
    await inventoryService.initializeSession(testSessionId, seats);
  });

  afterAll(async () => {
    // Clean up test keys
    await inventoryService.clearSession(testSessionId);
    await closeRedisClient();
  });

  describe('1. Redis Connection & Health Checks', () => {
    it('returns healthy status with latency measurement', async () => {
      const health = await checkRedisHealth();
      expect(health.status).toBe('up');
      expect(typeof health.latencyMs).toBe('number');
      expect(health.latencyMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe('2. Atomic Seat Hold (hold_seats.lua)', () => {
    it('successfully holds a single available seat', async () => {
      const resId = crypto.randomUUID();
      const userId = crypto.randomUUID();
      const idempKey = 'idemp-hold-1';

      const result = await inventoryService.holdSeats({
        sessionId: testSessionId,
        userId,
        reservationId: resId,
        seatIds: ['SEAT-A1'],
        idempotencyKey: idempKey,
        holdTtlSeconds: 300,
      });

      expect(result.success).toBe(true);
      expect(result.status).toBe('SUCCESS');
      expect(result.reservationId).toBe(resId);
      expect(result.seats).toEqual(['SEAT-A1']);

      // Verify seat status in Redis
      const statuses = await inventoryService.getSeatStatuses(testSessionId, ['SEAT-A1']);
      expect(statuses.get('SEAT-A1')).toBe('HELD');
    });

    it('successfully holds multiple available seats', async () => {
      const resId = crypto.randomUUID();
      const userId = crypto.randomUUID();
      const idempKey = 'idemp-hold-2';

      const result = await inventoryService.holdSeats({
        sessionId: testSessionId,
        userId,
        reservationId: resId,
        seatIds: ['SEAT-A2', 'SEAT-A3'],
        idempotencyKey: idempKey,
        holdTtlSeconds: 300,
      });

      expect(result.success).toBe(true);
      expect(result.status).toBe('SUCCESS');
      expect(result.seats).toEqual(['SEAT-A2', 'SEAT-A3']);

      const statuses = await inventoryService.getSeatStatuses(testSessionId, ['SEAT-A2', 'SEAT-A3']);
      expect(statuses.get('SEAT-A2')).toBe('HELD');
      expect(statuses.get('SEAT-A3')).toBe('HELD');
    });

    it('rejects duplicate seat IDs in the hold request', async () => {
      const resId = crypto.randomUUID();
      const userId = crypto.randomUUID();

      const result = await inventoryService.holdSeats({
        sessionId: testSessionId,
        userId,
        reservationId: resId,
        seatIds: ['SEAT-A4', 'SEAT-A4'],
        idempotencyKey: 'idemp-dup-seats',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('DUPLICATE_SEAT_IN_REQUEST');
      expect(result.seatId).toBe('SEAT-A4');

      // Verify seat remained AVAILABLE
      const statuses = await inventoryService.getSeatStatuses(testSessionId, ['SEAT-A4']);
      expect(statuses.get('SEAT-A4')).toBe('AVAILABLE');
    });

    it('rejects hold when a requested seat does not exist in inventory', async () => {
      const resId = crypto.randomUUID();
      const userId = crypto.randomUUID();

      const result = await inventoryService.holdSeats({
        sessionId: testSessionId,
        userId,
        reservationId: resId,
        seatIds: ['SEAT-A4', 'SEAT-NON-EXISTENT'],
        idempotencyKey: 'idemp-unknown-seat',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('SEAT_NOT_FOUND');
      expect(result.seatId).toBe('SEAT-NON-EXISTENT');

      // Crucial: SEAT-A4 must NOT have been allocated (Atomic all-or-nothing!)
      const statuses = await inventoryService.getSeatStatuses(testSessionId, ['SEAT-A4']);
      expect(statuses.get('SEAT-A4')).toBe('AVAILABLE');
    });

    it('enforces all-or-nothing: if 1 of N seats is unavailable, NONE are held', async () => {
      // SEAT-A1 is already HELD from previous test; SEAT-A4 is AVAILABLE
      const resId = crypto.randomUUID();
      const userId = crypto.randomUUID();

      const result = await inventoryService.holdSeats({
        sessionId: testSessionId,
        userId,
        reservationId: resId,
        seatIds: ['SEAT-A4', 'SEAT-A1'], // A4 available, A1 unavailable
        idempotencyKey: 'idemp-partial-test',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('SEAT_UNAVAILABLE');
      expect(result.seatId).toBe('SEAT-A1');

      // Verify SEAT-A4 remains AVAILABLE (no partial allocation!)
      const statuses = await inventoryService.getSeatStatuses(testSessionId, ['SEAT-A4']);
      expect(statuses.get('SEAT-A4')).toBe('AVAILABLE');
    });
  });

  describe('3. Concurrency & Contention Races', () => {
    it('two concurrent users racing for the same seat: exactly one succeeds', async () => {
      const targetSeat = 'SEAT-B1';
      const user1 = crypto.randomUUID();
      const user2 = crypto.randomUUID();
      const res1 = crypto.randomUUID();
      const res2 = crypto.randomUUID();

      // Launch concurrent holds simultaneously
      const [attempt1, attempt2] = await Promise.all([
        inventoryService.holdSeats({
          sessionId: testSessionId,
          userId: user1,
          reservationId: res1,
          seatIds: [targetSeat],
          idempotencyKey: 'idemp-race-1',
        }),
        inventoryService.holdSeats({
          sessionId: testSessionId,
          userId: user2,
          reservationId: res2,
          seatIds: [targetSeat],
          idempotencyKey: 'idemp-race-2',
        }),
      ]);

      const successCount = (attempt1.success ? 1 : 0) + (attempt2.success ? 1 : 0);
      const failCount = (!attempt1.success ? 1 : 0) + (!attempt2.success ? 1 : 0);

      expect(successCount).toBe(1);
      expect(failCount).toBe(1);

      const failedAttempt = attempt1.success ? attempt2 : attempt1;
      expect(failedAttempt.error).toBe('SEAT_UNAVAILABLE');
    });

    it('concurrent requests for overlapping seat sets: only non-conflicting succeeds', async () => {
      // User A requests [B2, B3], User B requests [B3, B4]
      const userA = crypto.randomUUID();
      const userB = crypto.randomUUID();
      const resA = crypto.randomUUID();
      const resB = crypto.randomUUID();

      const [attemptA, attemptB] = await Promise.all([
        inventoryService.holdSeats({
          sessionId: testSessionId,
          userId: userA,
          reservationId: resA,
          seatIds: ['SEAT-B2', 'SEAT-B3'],
          idempotencyKey: 'idemp-overlap-A',
        }),
        inventoryService.holdSeats({
          sessionId: testSessionId,
          userId: userB,
          reservationId: resB,
          seatIds: ['SEAT-B3', 'SEAT-B4'],
          idempotencyKey: 'idemp-overlap-B',
        }),
      ]);

      const successCount = (attemptA.success ? 1 : 0) + (attemptB.success ? 1 : 0);
      expect(successCount).toBe(1);

      // If A succeeded, B2 & B3 are HELD, and B4 remains AVAILABLE
      const statuses = await inventoryService.getSeatStatuses(testSessionId, ['SEAT-B2', 'SEAT-B3', 'SEAT-B4']);
      if (attemptA.success) {
        expect(statuses.get('SEAT-B2')).toBe('HELD');
        expect(statuses.get('SEAT-B3')).toBe('HELD');
        expect(statuses.get('SEAT-B4')).toBe('AVAILABLE');
      } else {
        expect(statuses.get('SEAT-B2')).toBe('AVAILABLE');
        expect(statuses.get('SEAT-B3')).toBe('HELD');
        expect(statuses.get('SEAT-B4')).toBe('HELD');
      }
    });
  });

  describe('4. Idempotency Semantics', () => {
    it('same user + same key + same payload: returns original result (IDEMPOTENT_REPLAY)', async () => {
      const resId = crypto.randomUUID();
      const userId = crypto.randomUUID();
      const idempKey = 'idemp-replay-test';

      const firstAttempt = await inventoryService.holdSeats({
        sessionId: testSessionId,
        userId,
        reservationId: resId,
        seatIds: ['SEAT-A4'],
        idempotencyKey: idempKey,
      });
      expect(firstAttempt.success).toBe(true);

      const replayAttempt = await inventoryService.holdSeats({
        sessionId: testSessionId,
        userId,
        reservationId: resId,
        seatIds: ['SEAT-A4'],
        idempotencyKey: idempKey,
      });

      expect(replayAttempt.success).toBe(true);
      expect(replayAttempt.status).toBe('IDEMPOTENT_REPLAY');
      expect(replayAttempt.reservationId).toBe(resId);
    });

    it('same user + same key + different payload: returns IDEMPOTENCY_CONFLICT', async () => {
      const userId = crypto.randomUUID();
      const idempKey = 'idemp-conflict-test';

      // First request with SEAT-EXP-1
      const first = await inventoryService.holdSeats({
        sessionId: testSessionId,
        userId,
        reservationId: crypto.randomUUID(),
        seatIds: ['SEAT-EXP-1'],
        idempotencyKey: idempKey,
      });
      expect(first.success).toBe(true);

      // Second request reusing the same key with different seat payload (SEAT-EXP-2)
      const conflict = await inventoryService.holdSeats({
        sessionId: testSessionId,
        userId,
        reservationId: crypto.randomUUID(),
        seatIds: ['SEAT-EXP-2'],
        idempotencyKey: idempKey,
      });

      expect(conflict.success).toBe(false);
      expect(conflict.error).toBe('IDEMPOTENCY_CONFLICT');
    });
  });

  describe('5. Atomic Seat Release & Expiry Handling (release_seats.lua)', () => {
    it('releases held seats back to AVAILABLE', async () => {
      // Create a fresh hold to release
      const resId = crypto.randomUUID();
      const userId = crypto.randomUUID();
      await inventoryService.holdSeats({
        sessionId: testSessionId,
        userId,
        reservationId: resId,
        seatIds: ['SEAT-EXP-2'],
        idempotencyKey: 'idemp-to-release',
      });

      const releaseRes = await inventoryService.releaseSeats({
        sessionId: testSessionId,
        reservationId: resId,
        userId,
        reason: 'CANCELLED',
      });

      expect(releaseRes.success).toBe(true);
      expect(releaseRes.status).toBe('SUCCESS');
      expect(releaseRes.releasedCount).toBe(1);

      const statuses = await inventoryService.getSeatStatuses(testSessionId, ['SEAT-EXP-2']);
      expect(statuses.get('SEAT-EXP-2')).toBe('AVAILABLE');
    });

    it('rejects release of another user reservation', async () => {
      const resId = crypto.randomUUID();
      const ownerId = crypto.randomUUID();
      const strangerId = crypto.randomUUID();

      await inventoryService.holdSeats({
        sessionId: testSessionId,
        userId: ownerId,
        reservationId: resId,
        seatIds: ['SEAT-EXP-2'],
        idempotencyKey: 'idemp-owner-test',
      });

      const unauthorizedRelease = await inventoryService.releaseSeats({
        sessionId: testSessionId,
        reservationId: resId,
        userId: strangerId,
        reason: 'CANCELLED',
      });

      expect(unauthorizedRelease.success).toBe(false);
      expect(unauthorizedRelease.error).toBe('UNAUTHORIZED_USER');

      // Clean up using owner
      await inventoryService.releaseSeats({
        sessionId: testSessionId,
        reservationId: resId,
        userId: ownerId,
        reason: 'CANCELLED',
      });
    });

    it('repeated release is safe and idempotent', async () => {
      const resId = crypto.randomUUID();
      const userId = crypto.randomUUID();

      await inventoryService.holdSeats({
        sessionId: testSessionId,
        userId,
        reservationId: resId,
        seatIds: ['SEAT-EXP-2'],
        idempotencyKey: 'idemp-double-rel',
      });

      const firstRel = await inventoryService.releaseSeats({
        sessionId: testSessionId,
        reservationId: resId,
        userId,
        reason: 'CANCELLED',
      });
      expect(firstRel.success).toBe(true);

      const secondRel = await inventoryService.releaseSeats({
        sessionId: testSessionId,
        reservationId: resId,
        userId,
        reason: 'CANCELLED',
      });
      expect(secondRel.success).toBe(true);
      expect(secondRel.status).toBe('ALREADY_RELEASED');
    });
  });

  describe('6. Booking Confirmation (confirm_seats.lua)', () => {
    it('confirms a held reservation and transitions seats to BOOKED', async () => {
      const resId = crypto.randomUUID();
      const userId = crypto.randomUUID();

      await inventoryService.holdSeats({
        sessionId: testSessionId,
        userId,
        reservationId: resId,
        seatIds: ['SEAT-EXP-2'],
        idempotencyKey: 'idemp-confirm-1',
        holdTtlSeconds: 300,
      });

      const confirmRes = await inventoryService.confirmSeats({
        sessionId: testSessionId,
        reservationId: resId,
        userId,
      });

      expect(confirmRes.success).toBe(true);
      expect(confirmRes.status).toBe('SUCCESS');
      expect(confirmRes.confirmedCount).toBe(1);

      const statuses = await inventoryService.getSeatStatuses(testSessionId, ['SEAT-EXP-2']);
      expect(statuses.get('SEAT-EXP-2')).toBe('BOOKED');
    });

    it('double confirmation is idempotent and returns ALREADY_CONFIRMED', async () => {
      // Create and confirm a reservation
      const resId = crypto.randomUUID();
      const userId = crypto.randomUUID();

      // Free up a seat
      await inventoryService.initializeSession(testSessionId, [{ seatId: 'SEAT-CONF-DBL', status: 'AVAILABLE' }]);

      await inventoryService.holdSeats({
        sessionId: testSessionId,
        userId,
        reservationId: resId,
        seatIds: ['SEAT-CONF-DBL'],
        idempotencyKey: 'idemp-dbl-conf',
      });

      const first = await inventoryService.confirmSeats({
        sessionId: testSessionId,
        reservationId: resId,
        userId,
      });
      expect(first.success).toBe(true);

      const second = await inventoryService.confirmSeats({
        sessionId: testSessionId,
        reservationId: resId,
        userId,
      });
      expect(second.success).toBe(true);
      expect(second.status).toBe('ALREADY_CONFIRMED');
    });

    it('rejects confirmation of an expired reservation', async () => {
      const resId = crypto.randomUUID();
      const userId = crypto.randomUUID();

      // Free seat
      await inventoryService.initializeSession(testSessionId, [{ seatId: 'SEAT-EXP-FAIL', status: 'AVAILABLE' }]);

      // Hold with 1-second TTL
      await inventoryService.holdSeats({
        sessionId: testSessionId,
        userId,
        reservationId: resId,
        seatIds: ['SEAT-EXP-FAIL'],
        idempotencyKey: 'idemp-exp-fail',
        holdTtlSeconds: 1,
      });

      // Wait 1.1s for hold to expire
      await new Promise((resolve) => setTimeout(resolve, 1100));

      const confirmRes = await inventoryService.confirmSeats({
        sessionId: testSessionId,
        reservationId: resId,
        userId,
      });

      expect(confirmRes.success).toBe(false);
      expect(confirmRes.error).toBe('RESERVATION_EXPIRED');
    });
  });

  describe('7. Expiry Worker & Auto-Reclamation', () => {
    it('discovers expired holds via Sorted Set and automatically restores seats to AVAILABLE', async () => {
      const resId = crypto.randomUUID();
      const userId = crypto.randomUUID();

      await inventoryService.initializeSession(testSessionId, [{ seatId: 'SEAT-SWEEP', status: 'AVAILABLE' }]);

      // Hold seat for 1 second
      await inventoryService.holdSeats({
        sessionId: testSessionId,
        userId,
        reservationId: resId,
        seatIds: ['SEAT-SWEEP'],
        idempotencyKey: 'idemp-sweep-test',
        holdTtlSeconds: 1,
      });

      // Verify seat is initially HELD
      let statuses = await inventoryService.getSeatStatuses(testSessionId, ['SEAT-SWEEP']);
      expect(statuses.get('SEAT-SWEEP')).toBe('HELD');

      // Wait 1.1s for expiration
      await new Promise((resolve) => setTimeout(resolve, 1100));

      // Run expiry sweeper
      const sweepResult = await expiryService.sweepSession(testSessionId);
      expect(sweepResult.scannedCount).toBeGreaterThanOrEqual(1);
      expect(sweepResult.reclaimedCount).toBeGreaterThanOrEqual(1);
      expect(sweepResult.expiredReservations).toContain(resId);

      // Verify seat is cleanly restored to AVAILABLE!
      statuses = await inventoryService.getSeatStatuses(testSessionId, ['SEAT-SWEEP']);
      expect(statuses.get('SEAT-SWEEP')).toBe('AVAILABLE');
    });
  });
});
