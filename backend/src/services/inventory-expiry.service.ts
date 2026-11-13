import type { Redis } from 'ioredis';
import { getRedisClient } from '../config/redis.js';
import { RedisKeys } from '../redis/keys.js';
import { RedisInventoryService } from './inventory.service.js';
import { logger } from '../utils/logger.js';
import { metrics } from '../utils/metrics.js';

export interface ExpirySweepResult {
  sessionId: string;
  scannedCount: number;
  reclaimedCount: number;
  failedCount: number;
  expiredReservations: string[];
}

export class ReservationExpiryService {
  private inventoryService: RedisInventoryService;
  private isRunning = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(private customClient?: Redis) {
    this.inventoryService = new RedisInventoryService(customClient);
  }

  private async getClient(): Promise<Redis> {
    if (this.customClient) {
      return this.customClient;
    }
    return getRedisClient();
  }

  /**
   * Discovers and reclaims expired reservations for a specific session.
   * Uses sorted set ZRANGEBYSCORE to identify expired holds, then executes
   * atomic release_seats.lua.
   */
  async sweepSession(sessionId: string, batchSize = 100): Promise<ExpirySweepResult> {
    const client = await this.getClient();
    const expirationsKey = RedisKeys.reservationExpirations(sessionId);
    const nowMs = Date.now();

    metrics.increment('inventory_expiry_sweep_cycles_total');

    // Retrieve expired reservation IDs up to the current timestamp
    const expiredIds = await client.zrangebyscore(expirationsKey, '-inf', nowMs, 'LIMIT', 0, batchSize);

    const result: ExpirySweepResult = {
      sessionId,
      scannedCount: expiredIds.length,
      reclaimedCount: 0,
      failedCount: 0,
      expiredReservations: [],
    };

    if (expiredIds.length === 0) {
      return result;
    }

    logger.info(`Found ${expiredIds.length} expired reservation(s) in session ${sessionId}. Reclaiming...`);

    for (const resId of expiredIds) {
      try {
        const releaseRes = await this.inventoryService.releaseSeats({
          sessionId,
          reservationId: resId,
          userId: 'SYSTEM_EXPIRY',
          reason: 'EXPIRED',
        });

        if (releaseRes.success) {
          result.reclaimedCount++;
          result.expiredReservations.push(resId);
          metrics.increment('inventory_expiry_reclaimed_total');
        } else {
          result.failedCount++;
          metrics.increment('inventory_expiry_failed_total');
          logger.warn(`Failed auto-releasing expired reservation ${resId}: ${releaseRes.error}`);
        }
      } catch (err: unknown) {
        result.failedCount++;
        metrics.increment('inventory_expiry_failed_total');
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`Exception while reclaiming expired reservation ${resId}:`, msg);
      }
    }

    return result;
  }

  /**
   * Start a recurring background expiry sweeper.
   */
  startBackgroundSweeper(sessionsSupplier: () => Promise<string[]>, intervalMs = 5000): void {
    if (this.isRunning) return;
    this.isRunning = true;

    const runLoop = async () => {
      if (!this.isRunning) return;
      try {
        const sessions = await sessionsSupplier();
        for (const sessionId of sessions) {
          await this.sweepSession(sessionId);
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error('Error in background reservation expiry loop:', msg);
      } finally {
        if (this.isRunning) {
          this.timer = setTimeout(runLoop, intervalMs);
        }
      }
    };

    this.timer = setTimeout(runLoop, intervalMs);
    logger.info(`Started background reservation expiry worker (interval: ${intervalMs}ms).`);
  }

  /**
   * Stop the background expiry sweeper cleanly.
   */
  stopBackgroundSweeper(): void {
    this.isRunning = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    logger.info('Stopped background reservation expiry worker.');
  }
}
