import crypto from 'crypto';
import { createRedisClient, checkRedisHealth, closeRedisClient } from '../src/config/redis.js';
import { RedisInventoryService } from '../src/services/inventory.service.js';
import { ReservationExpiryService } from '../src/services/inventory-expiry.service.js';

describe('DropShield Phase 4: Redis Failure & Recovery Test Suite', () => {
  let inventoryService: RedisInventoryService;
  const testSessionId = 'sess-fail-rec-' + crypto.randomUUID();

  beforeAll(async () => {
    inventoryService = new RedisInventoryService();

    await inventoryService.initializeSession(testSessionId, [
      { seatId: 'SEAT-FAIL-1' },
      { seatId: 'SEAT-FAIL-2' },
      { seatId: 'SEAT-RESTART-1' },
    ]);
  });

  afterAll(async () => {
    await inventoryService.clearSession(testSessionId);
    await closeRedisClient();
  });

  describe('1. Input Validation & Fault Preemption', () => {
    it('rejects empty seat selection before invoking Lua script', async () => {
      let threw = false;
      try {
        await inventoryService.holdSeats({
          sessionId: testSessionId,
          userId: crypto.randomUUID(),
          reservationId: crypto.randomUUID(),
          seatIds: [],
          idempotencyKey: 'idemp-empty',
        });
      } catch (err: any) {
        threw = true;
        expect(err.message).toMatch(/At least one seat must be specified/i);
      }
      expect(threw).toBe(true);
    });

    it('rejects invalid hold TTL (> 3600 seconds or <= 0)', async () => {
      let threwZero = false;
      try {
        await inventoryService.holdSeats({
          sessionId: testSessionId,
          userId: crypto.randomUUID(),
          reservationId: crypto.randomUUID(),
          seatIds: ['SEAT-FAIL-1'],
          idempotencyKey: 'idemp-ttl',
          holdTtlSeconds: 0,
        });
      } catch (err: any) {
        threwZero = true;
        expect(err.message).toMatch(/holdTtlSeconds must be between 1 and 3600/i);
      }
      expect(threwZero).toBe(true);

      let threwHuge = false;
      try {
        await inventoryService.holdSeats({
          sessionId: testSessionId,
          userId: crypto.randomUUID(),
          reservationId: crypto.randomUUID(),
          seatIds: ['SEAT-FAIL-1'],
          idempotencyKey: 'idemp-ttl',
          holdTtlSeconds: 5000,
        });
      } catch (err: any) {
        threwHuge = true;
        expect(err.message).toMatch(/holdTtlSeconds must be between 1 and 3600/i);
      }
      expect(threwHuge).toBe(true);
    });

    it('rejects missing mandatory parameters', async () => {
      let threw = false;
      try {
        await inventoryService.holdSeats({
          sessionId: '',
          userId: crypto.randomUUID(),
          reservationId: crypto.randomUUID(),
          seatIds: ['SEAT-FAIL-1'],
          idempotencyKey: 'idemp-missing',
        });
      } catch (err: any) {
        threw = true;
        expect(err.message).toMatch(/mandatory/i);
      }
      expect(threw).toBe(true);
    });
  });

  describe('2. Disconnection & Health Probes', () => {
    it('checkRedisHealth accurately reports "down" when given an unreachable client', async () => {
      // Create disconnected client pointing to an inactive port
      const badClient = createRedisClient({
        port: 65432,
        connectTimeout: 500,
        retryStrategy: () => null, // Do not reconnect
      });

      const health = await checkRedisHealth(badClient);
      expect(health.status).toBe('down');
      expect(health.error).toBeDefined();

      badClient.removeAllListeners();
      try {
        badClient.disconnect(false);
      } catch {
        // ignore
      }
    });
  });

  describe('3. Worker Crash & Expired Reservation Recovery', () => {
    it('simulates worker crash during active hold: subsequent sweeper recovers expired seats cleanly', async () => {
      const resId = crypto.randomUUID();
      const userId = crypto.randomUUID();

      // Hold a seat with 1-second lease
      const holdRes = await inventoryService.holdSeats({
        sessionId: testSessionId,
        userId,
        reservationId: resId,
        seatIds: ['SEAT-RESTART-1'],
        idempotencyKey: 'idemp-crash-recovery',
        holdTtlSeconds: 1,
      });
      expect(holdRes.success).toBe(true);

      // Simulate worker crash: sweeper does NOT run during hold expiration
      // Wait for hold to expire
      await new Promise((resolve) => setTimeout(resolve, 1100));

      // New worker process boots up and executes session sweep
      const recoveryService = new ReservationExpiryService();
      const recoveryResult = await recoveryService.sweepSession(testSessionId);

      expect(recoveryResult.scannedCount).toBeGreaterThanOrEqual(1);
      expect(recoveryResult.reclaimedCount).toBeGreaterThanOrEqual(1);
      expect(recoveryResult.expiredReservations).toContain(resId);

      // Verify seat is available again after worker reboot
      const statuses = await inventoryService.getSeatStatuses(testSessionId, ['SEAT-RESTART-1']);
      expect(statuses.get('SEAT-RESTART-1')).toBe('AVAILABLE');
    });
  });
});
