import crypto from 'crypto';
import type { Redis } from 'ioredis';
import { dbPool } from '../config/database.js';
import { getRedisClient } from '../config/redis.js';
import { RedisKeys } from '../redis/keys.js';
import { getLuaScripts, executeLuaScript } from '../redis/scripts.js';
import { failureInjector } from '../testing/failure-injector.js';
import { logger } from '../utils/logger.js';
import { metrics } from '../utils/metrics.js';

export type SeatStatus = 'AVAILABLE' | 'HELD' | 'BOOKED';

export interface SeatInventoryItem {
  seatId: string;
  status?: SeatStatus;
}

export interface HoldSeatsParams {
  sessionId: string;
  userId: string;
  reservationId: string;
  seatIds: string[];
  idempotencyKey: string;
  holdTtlSeconds?: number;
}

export interface HoldSeatsResult {
  success: boolean;
  status?: string;
  reservationId?: string;
  expiresAt?: number;
  seats?: string[];
  error?: string;
  message?: string;
  seatId?: string;
  currentStatus?: string;
}

export interface ReleaseSeatsParams {
  sessionId: string;
  reservationId: string;
  userId?: string;
  idempotencyKey?: string;
  reason?: 'EXPIRED' | 'CANCELLED' | 'MANUAL' | 'COMPENSATION_ROLLBACK';
}

export interface ReleaseSeatsResult {
  success: boolean;
  status?: string;
  reservationId?: string;
  reason?: string;
  releasedCount?: number;
  seats?: string[];
  error?: string;
  message?: string;
}

export interface ConfirmSeatsParams {
  sessionId: string;
  reservationId: string;
  userId: string;
  idempotencyKey?: string;
}

export interface ConfirmSeatsResult {
  success: boolean;
  status?: string;
  reservationId?: string;
  confirmedCount?: number;
  seats?: string[];
  error?: string;
  message?: string;
  currentStatus?: string;
  seatId?: string;
  expiresAt?: number;
}

export interface ReservationDetails {
  id: string;
  userId: string;
  status: string;
  createdAt: number;
  expiresAt: number;
  requestHash: string;
  seatCount: number;
  seats: string[];
}

export class RedisInventoryService {
  constructor(private customClient?: Redis) {}

  private async getClient(): Promise<Redis> {
    if (this.customClient) {
      return this.customClient;
    }
    return getRedisClient();
  }

  /**
   * Pre-populates a session's seat inventory in Redis.
   */
  async initializeSession(sessionId: string, seats: SeatInventoryItem[]): Promise<void> {
    if (!sessionId || sessionId.trim() === '') {
      throw new Error('sessionId is required for inventory initialization');
    }
    if (!Array.isArray(seats) || seats.length === 0) {
      throw new Error('At least one seat is required for session initialization');
    }

    const client = await this.getClient();
    const seatsKey = RedisKeys.sessionSeats(sessionId);

    const pipeline = client.pipeline();
    for (const seat of seats) {
      pipeline.hset(seatsKey, seat.seatId, seat.status || 'AVAILABLE');
    }
    await pipeline.exec();

    logger.info(`Initialized ${seats.length} seats for session: ${sessionId}`);
  }

  /**
   * Reconstitutes session inventory in Redis from PostgreSQL (source of truth).
   * Restores session seats hash, active reservations metadata, and expiration sorted set.
   */
  async reconstructSessionInventory(sessionId: string): Promise<{ restoredSeats: number; restoredReservations: number }> {
    const client = await this.getClient();
    const seatsKey = RedisKeys.sessionSeats(sessionId);
    const expirationsKey = RedisKeys.reservationExpirations(sessionId);

    // 1. Fetch all seats for the session from PostgreSQL
    const seatsResult = await dbPool.query<{ id: string; status: SeatStatus }>(
      `SELECT id, status FROM session_seats WHERE event_session_id = $1;`,
      [sessionId]
    );

    if (seatsResult.rows.length === 0) {
      return { restoredSeats: 0, restoredReservations: 0 };
    }

    const pipeline = client.pipeline();
    // Re-populate seat hash
    for (const seat of seatsResult.rows) {
      pipeline.hset(seatsKey, seat.id, seat.status);
    }

    // 2. Fetch active (unexpired) pending reservations for this session
    const resResult = await dbPool.query<{
      id: string;
      user_id: string;
      status: string;
      created_at: Date;
      expires_at: Date;
    }>(
      `SELECT id, user_id, status, created_at, expires_at
       FROM reservations
       WHERE event_session_id = $1 AND status = 'PENDING' AND expires_at > CURRENT_TIMESTAMP;`,
      [sessionId]
    );

    let restoredReservations = 0;
    for (const res of resResult.rows) {
      const resMetaKey = RedisKeys.reservationMeta(sessionId, res.id);
      const resSeatsKey = RedisKeys.reservationSeats(sessionId, res.id);
      const expiresAtMs = new Date(res.expires_at).getTime();
      const createdAtMs = new Date(res.created_at).getTime();

      // Find seats for this reservation
      const resSeatsResult = await dbPool.query<{ session_seat_id: string }>(
        `SELECT session_seat_id FROM reservation_items WHERE reservation_id = $1;`,
        [res.id]
      );
      const seatIds = resSeatsResult.rows.map((r) => r.session_seat_id);

      pipeline.hmset(resMetaKey, {
        id: res.id,
        user_id: res.user_id,
        status: 'HELD',
        created_at: createdAtMs.toString(),
        expires_at: expiresAtMs.toString(),
        request_hash: 'reconstructed',
        seat_count: seatIds.length.toString(),
      });

      if (seatIds.length > 0) {
        pipeline.sadd(resSeatsKey, ...seatIds);
      }
      pipeline.zadd(expirationsKey, expiresAtMs, res.id);
      restoredReservations++;
    }

    await pipeline.exec();
    logger.info(`Reconstructed Redis inventory for session ${sessionId}: ${seatsResult.rows.length} seats, ${restoredReservations} active reservations.`);
    return {
      restoredSeats: seatsResult.rows.length,
      restoredReservations,
    };
  }

  /**
   * Helper for executing Redis operations with exponential backoff and jitter.
   */
  async executeWithRetry<T>(
    operation: () => Promise<T>,
    maxRetries = 3,
    baseDelayMs = 50
  ): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await operation();
      } catch (err) {
        lastError = err;
        if (attempt === maxRetries) break;
        const jitter = Math.random() * 20;
        const delay = Math.min(baseDelayMs * Math.pow(2, attempt) + jitter, 1000);
        await new Promise((res) => setTimeout(res, delay));
      }
    }
    throw lastError;
  }

  /**
   * Atomically reserve multiple requested seats.
   * Guarantees all-or-nothing hold semantics, idempotency, and cluster hash-tag safety.
   */
  async holdSeats(params: HoldSeatsParams): Promise<HoldSeatsResult> {
    const start = Date.now();
    metrics.increment('inventory_hold_attempts_total');

    const {
      sessionId,
      userId,
      reservationId,
      seatIds,
      idempotencyKey,
      holdTtlSeconds = 600, // Default 10 minutes
    } = params;

    // Input validations
    if (!sessionId || !userId || !reservationId || !idempotencyKey) {
      throw new Error('sessionId, userId, reservationId, and idempotencyKey are mandatory');
    }
    if (!Array.isArray(seatIds) || seatIds.length === 0) {
      throw new Error('At least one seat must be specified');
    }
    if (holdTtlSeconds <= 0 || holdTtlSeconds > 3600) {
      throw new Error('holdTtlSeconds must be between 1 and 3600 seconds');
    }

    // Compute deterministic request hash
    const normalizedSeats = [...seatIds].sort();
    const payloadSignature = `${userId}:${sessionId}:${normalizedSeats.join(',')}`;
    const requestHash = crypto.createHash('sha256').update(payloadSignature, 'utf8').digest('hex');

    const nowMs = Date.now();
    const expiresAtMs = nowMs + holdTtlSeconds * 1000;

    const keys = [
      RedisKeys.sessionSeats(sessionId),
      RedisKeys.reservationMeta(sessionId, reservationId),
      RedisKeys.reservationSeats(sessionId, reservationId),
      RedisKeys.reservationExpirations(sessionId),
      RedisKeys.idempotency(sessionId, userId, idempotencyKey),
    ];

    const args = [
      reservationId,
      userId,
      nowMs,
      expiresAtMs,
      requestHash,
      holdTtlSeconds,
      ...seatIds,
    ];

    const client = await this.getClient();
    const { holdSeats } = getLuaScripts();

    await failureInjector.trigger('REDIS_HOLD_FAILURE');

    const result = await executeLuaScript<HoldSeatsResult>(client, holdSeats, keys, args);

    const duration = Date.now() - start;
    metrics.recordDuration('inventory_hold_duration_ms', duration);

    if (result.success) {
      metrics.increment('inventory_hold_success_total');
      logger.info(`Held ${seatIds.length} seat(s) for session ${sessionId} [res: ${reservationId}, duration: ${duration}ms]`);
    } else {
      metrics.increment('inventory_hold_conflicts_total');
      logger.warn(`Hold rejected for session ${sessionId} [error: ${result.error}, seat: ${result.seatId || 'N/A'}]`);
    }

    return result;
  }

  /**
   * Atomically release seats associated with a reservation.
   */
  async releaseSeats(params: ReleaseSeatsParams): Promise<ReleaseSeatsResult> {
    const start = Date.now();
    metrics.increment('inventory_release_attempts_total');

    const {
      sessionId,
      reservationId,
      userId = 'SYSTEM',
      idempotencyKey = '',
      reason = 'EXPIRED',
    } = params;

    const keys = [
      RedisKeys.sessionSeats(sessionId),
      RedisKeys.reservationMeta(sessionId, reservationId),
      RedisKeys.reservationSeats(sessionId, reservationId),
      RedisKeys.reservationExpirations(sessionId),
      idempotencyKey ? RedisKeys.idempotency(sessionId, userId, idempotencyKey) : '',
    ];

    const nowMs = Date.now();
    const args = [reservationId, userId, reason, nowMs];

    const client = await this.getClient();
    const { releaseSeats } = getLuaScripts();

    await failureInjector.trigger('REDIS_RELEASE_FAILURE');

    const result = await executeLuaScript<ReleaseSeatsResult>(client, releaseSeats, keys, args);

    const duration = Date.now() - start;
    metrics.recordDuration('inventory_release_duration_ms', duration);

    if (result.success) {
      metrics.increment('inventory_release_success_total');
      logger.info(`Released reservation ${reservationId} for session ${sessionId} (reason: ${reason}, count: ${result.releasedCount ?? 0})`);
    } else {
      metrics.increment('inventory_release_failed_total');
      logger.warn(`Failed releasing reservation ${reservationId} for session ${sessionId}: ${result.error}`);
    }

    return result;
  }

  /**
   * Atomically confirm seats transitioning from HELD to BOOKED.
   */
  async confirmSeats(params: ConfirmSeatsParams): Promise<ConfirmSeatsResult> {
    const start = Date.now();
    metrics.increment('inventory_confirm_attempts_total');

    const { sessionId, reservationId, userId, idempotencyKey = '' } = params;

    const keys = [
      RedisKeys.sessionSeats(sessionId),
      RedisKeys.reservationMeta(sessionId, reservationId),
      RedisKeys.reservationSeats(sessionId, reservationId),
      RedisKeys.reservationExpirations(sessionId),
      idempotencyKey ? RedisKeys.idempotency(sessionId, userId, idempotencyKey) : '',
    ];

    const nowMs = Date.now();
    const args = [reservationId, userId, nowMs];

    const client = await this.getClient();
    const { confirmSeats } = getLuaScripts();

    await failureInjector.trigger('REDIS_CONFIRM_FAILURE');

    const result = await executeLuaScript<ConfirmSeatsResult>(client, confirmSeats, keys, args);

    const duration = Date.now() - start;
    metrics.recordDuration('inventory_confirm_duration_ms', duration);

    if (result.success) {
      metrics.increment('inventory_confirm_success_total');
      logger.info(`Confirmed reservation ${reservationId} for session ${sessionId} [status: ${result.status}]`);
    } else {
      metrics.increment('inventory_confirm_failed_total');
      logger.warn(`Failed confirmation for reservation ${reservationId}: ${result.error}`);
    }

    return result;
  }

  /**
   * Read the real-time status of requested seats or all session seats.
   */
  async getSeatStatuses(sessionId: string, seatIds?: string[]): Promise<Map<string, SeatStatus>> {
    const client = await this.getClient();
    const seatsKey = RedisKeys.sessionSeats(sessionId);

    const resultMap = new Map<string, SeatStatus>();
    if (seatIds && seatIds.length > 0) {
      const values = await client.hmget(seatsKey, ...seatIds);
      seatIds.forEach((id, idx) => {
        if (values[idx]) {
          resultMap.set(id, values[idx] as SeatStatus);
        }
      });
    } else {
      const all = await client.hgetall(seatsKey);
      for (const [id, status] of Object.entries(all)) {
        resultMap.set(id, status as SeatStatus);
      }
    }
    return resultMap;
  }

  /**
   * Retrieve full details of a reservation.
   */
  async getReservation(sessionId: string, reservationId: string): Promise<ReservationDetails | null> {
    const client = await this.getClient();
    const resKey = RedisKeys.reservationMeta(sessionId, reservationId);
    const seatsKey = RedisKeys.reservationSeats(sessionId, reservationId);

    const meta = await client.hgetall(resKey);
    if (!meta || Object.keys(meta).length === 0) {
      return null;
    }

    const seats = await client.smembers(seatsKey);

    return {
      id: meta.id,
      userId: meta.user_id,
      status: meta.status,
      createdAt: parseInt(meta.created_at, 10),
      expiresAt: parseInt(meta.expires_at, 10),
      requestHash: meta.request_hash,
      seatCount: parseInt(meta.seat_count, 10) || seats.length,
      seats,
    };
  }

  /**
   * Clear all Redis keys associated with a session (useful for test isolation).
   */
  async clearSession(sessionId: string): Promise<void> {
    const client = await this.getClient();
    const pattern = `dropshield:{${sessionId}}:*`;
    const keys = await client.keys(pattern);
    if (keys.length > 0) {
      await client.del(...keys);
    }
  }
}
