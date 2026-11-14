import crypto from 'crypto';
import type pg from 'pg';
import { dbPool } from '../config/database.js';
import { getRedisClient } from '../config/redis.js';
import { RedisKeys } from '../redis/keys.js';
import { RedisInventoryService } from './inventory.service.js';
import { logger } from '../utils/logger.js';
import { metrics } from '../utils/metrics.js';

export interface DiscrepancyItem {
  id: string;
  type:
    | 'REDIS_ORPHAN_HOLD'
    | 'POSTGRES_PENDING_MISSING_REDIS'
    | 'EXPIRED_RESERVATION_STUCK'
    | 'REDIS_ORPHAN_BOOKED'
    | 'POSTGRES_BOOKED_MISSING_REDIS'
    | 'STUCK_OUTBOX_EVENT'
    | 'PAYMENT_BOOKING_DISAGREEMENT'
    | 'MISSING_LEDGER_RECORD';
  entityId: string;
  sessionId?: string;
  details: string;
  repaired: boolean;
  repairAction?: string;
  error?: string;
}

export interface ReconciliationOptions {
  dryRun?: boolean;
  batchSize?: number;
  outboxStaleMinutes?: number;
  sessionIds?: string[];
}

export interface ReconciliationReport {
  reconciliationId: string;
  dryRun: boolean;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  totalDetected: number;
  totalRepaired: number;
  totalFailed: number;
  discrepancies: DiscrepancyItem[];
}

export class ReconciliationService {
  private inventoryService: RedisInventoryService;
  private static readonly ADVISORY_LOCK_ID = 740001;

  constructor(inventoryService?: RedisInventoryService) {
    this.inventoryService = inventoryService || new RedisInventoryService();
  }

  /**
   * Run multi-system reconciliation across PostgreSQL, Redis, and Outbox.
   * Safe across multiple distributed instances via PostgreSQL transaction advisory locks.
   */
  async runReconciliation(options: ReconciliationOptions = {}): Promise<ReconciliationReport> {
    const startTime = Date.now();
    const reconciliationId = `rec_${crypto.randomUUID()}`;
    const dryRun = options.dryRun ?? false;
    const batchSize = options.batchSize ?? 100;
    const outboxStaleMinutes = options.outboxStaleMinutes ?? 5;

    logger.info(`Starting reconciliation run [${reconciliationId}] (dryRun: ${dryRun})...`);
    metrics.increment('reconciliation_runs_total');

    const client = await dbPool.connect();
    const discrepancies: DiscrepancyItem[] = [];

    try {
      await client.query('BEGIN');

      // 1. Acquire distributed advisory lock
      const lockRes = await client.query<{ locked: boolean }>(
        `SELECT pg_try_advisory_xact_lock($1) AS locked;`,
        [ReconciliationService.ADVISORY_LOCK_ID]
      );

      if (!lockRes.rows[0]?.locked) {
        logger.warn(`Reconciliation run ${reconciliationId} aborted: Another instance holds the advisory lock.`);
        metrics.increment('reconciliation_lock_busy_total');
        await client.query('ROLLBACK');
        return {
          reconciliationId,
          dryRun,
          startedAt: new Date(startTime).toISOString(),
          completedAt: new Date().toISOString(),
          durationMs: Date.now() - startTime,
          totalDetected: 0,
          totalRepaired: 0,
          totalFailed: 0,
          discrepancies: [
            {
              id: crypto.randomUUID(),
              type: 'STUCK_OUTBOX_EVENT',
              entityId: 'LOCK',
              details: 'Reconciliation lock held by another process',
              repaired: false,
            },
          ],
        };
      }

      // 2. Audit & Repair Expired Stuck Reservations
      await this.reconcileExpiredReservations(client, dryRun, batchSize, discrepancies);

      // 3. Audit & Repair Stuck Outbox Events
      await this.reconcileStuckOutboxEvents(client, dryRun, outboxStaleMinutes, batchSize, discrepancies);

      // 4. Audit & Repair Payment & Ledger Consistency
      await this.reconcilePaymentAndLedgerState(client, dryRun, batchSize, discrepancies);

      // 5. Audit & Repair Session Inventory & Redis Drift
      await this.reconcileSessionInventory(client, dryRun, options.sessionIds, discrepancies);

      if (!dryRun) {
        await client.query('COMMIT');
      } else {
        await client.query('ROLLBACK');
      }
    } catch (err) {
      await client.query('ROLLBACK');
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`Reconciliation run ${reconciliationId} failed:`, msg);
      throw err;
    } finally {
      client.release();
    }

    const durationMs = Date.now() - startTime;
    const totalDetected = discrepancies.length;
    const totalRepaired = discrepancies.filter((d) => d.repaired).length;
    const totalFailed = discrepancies.filter((d) => !d.repaired && !dryRun).length;

    metrics.recordTiming('reconciliation_duration_ms', durationMs);
    metrics.increment('reconciliation_discrepancies_detected_total', totalDetected);
    metrics.increment('reconciliation_discrepancies_repaired_total', totalRepaired);

    logger.info(
      `Reconciliation ${reconciliationId} completed in ${durationMs}ms: ${totalDetected} detected, ${totalRepaired} repaired, ${totalFailed} unresolved.`
    );

    return {
      reconciliationId,
      dryRun,
      startedAt: new Date(startTime).toISOString(),
      completedAt: new Date().toISOString(),
      durationMs,
      totalDetected,
      totalRepaired,
      totalFailed,
      discrepancies,
    };
  }

  /**
   * Identifies reservations that have passed expires_at but remain in PENDING state.
   * Releases session_seats back to AVAILABLE and updates reservation status to EXPIRED.
   */
  private async reconcileExpiredReservations(
    client: pg.PoolClient,
    dryRun: boolean,
    batchSize: number,
    discrepancies: DiscrepancyItem[]
  ): Promise<void> {
    const expiredRes = await client.query(
      `SELECT id, event_session_id, user_id, expires_at
       FROM reservations
       WHERE status = 'PENDING' AND expires_at < CURRENT_TIMESTAMP
       ORDER BY expires_at ASC
       LIMIT $1
       FOR UPDATE SKIP LOCKED;`,
      [batchSize]
    );

    for (const row of expiredRes.rows) {
      const item: DiscrepancyItem = {
        id: crypto.randomUUID(),
        type: 'EXPIRED_RESERVATION_STUCK',
        entityId: row.id,
        sessionId: row.event_session_id,
        details: `Reservation ${row.id} expired at ${row.expires_at} but remained PENDING`,
        repaired: false,
      };

      if (!dryRun) {
        try {
          // 1. Mark reservation EXPIRED
          await client.query(
            `UPDATE reservations
             SET status = 'EXPIRED', updated_at = CURRENT_TIMESTAMP
             WHERE id = $1;`,
            [row.id]
          );

          // 2. Reset session seats to AVAILABLE
          await client.query(
            `UPDATE session_seats
             SET status = 'AVAILABLE',
                 current_reservation_id = NULL,
                 hold_expires_at = NULL,
                 updated_at = CURRENT_TIMESTAMP
             WHERE current_reservation_id = $1;`,
            [row.id]
          );

          // 3. Release Redis hold
          await this.inventoryService.releaseSeats({
            sessionId: row.event_session_id,
            reservationId: row.id,
            userId: 'SYSTEM_EXPIRY',
            reason: 'EXPIRED',
          });

          item.repaired = true;
          item.repairAction = 'Marked EXPIRED, session_seats released to AVAILABLE, and Redis hold purged';
        } catch (repairErr: unknown) {
          const msg = repairErr instanceof Error ? repairErr.message : String(repairErr);
          item.error = msg;
          logger.error(`Failed repairing expired reservation ${row.id}:`, msg);
        }
      }

      discrepancies.push(item);
    }
  }

  /**
   * Identifies outbox events stuck in PROCESSING or PENDING beyond threshold.
   * Unlocks stale events so outbox workers can publish them without loss.
   */
  private async reconcileStuckOutboxEvents(
    client: pg.PoolClient,
    dryRun: boolean,
    staleMinutes: number,
    batchSize: number,
    discrepancies: DiscrepancyItem[]
  ): Promise<void> {
    const stuckRes = await client.query(
      `SELECT id, aggregate_id, event_type, status, attempts, locked_at
       FROM outbox_events
       WHERE (status = 'PROCESSING' AND locked_at < CURRENT_TIMESTAMP - ($1 * INTERVAL '1 minute'))
          OR (status = 'PENDING' AND available_at < CURRENT_TIMESTAMP - ($1 * INTERVAL '1 minute') AND attempts > 0)
       ORDER BY created_at ASC
       LIMIT $2
       FOR UPDATE SKIP LOCKED;`,
      [staleMinutes, batchSize]
    );

    for (const row of stuckRes.rows) {
      const item: DiscrepancyItem = {
        id: crypto.randomUUID(),
        type: 'STUCK_OUTBOX_EVENT',
        entityId: row.id,
        details: `Outbox event ${row.id} (${row.event_type}) stuck in ${row.status} (attempts: ${row.attempts})`,
        repaired: false,
      };

      if (!dryRun) {
        try {
          await client.query(
            `UPDATE outbox_events
             SET status = 'PENDING',
                 available_at = CURRENT_TIMESTAMP,
                 locked_at = NULL,
                 locked_by = NULL
             WHERE id = $1;`,
            [row.id]
          );

          item.repaired = true;
          item.repairAction = 'Unlocked and rescheduled outbox event for immediate publication';
        } catch (repairErr: unknown) {
          item.error = repairErr instanceof Error ? repairErr.message : String(repairErr);
        }
      }

      discrepancies.push(item);
    }
  }

  /**
   * Ensures every successful payment has a corresponding confirmed booking and an immutable ledger charge.
   */
  private async reconcilePaymentAndLedgerState(
    client: pg.PoolClient,
    dryRun: boolean,
    batchSize: number,
    discrepancies: DiscrepancyItem[]
  ): Promise<void> {
    // 1. Check for payments marked SUCCEEDED where booking status is not CONFIRMED
    const unconfirmedBookings = await client.query(
      `SELECT p.id as payment_id, p.booking_id, p.amount_minor, p.currency, b.status as booking_status
       FROM payments p
       JOIN bookings b ON b.id = p.booking_id
       WHERE p.status = 'SUCCEEDED' AND b.status != 'CONFIRMED' AND b.status != 'REFUNDED'
       LIMIT $1;`,
      [batchSize]
    );

    for (const row of unconfirmedBookings.rows) {
      const item: DiscrepancyItem = {
        id: crypto.randomUUID(),
        type: 'PAYMENT_BOOKING_DISAGREEMENT',
        entityId: row.payment_id,
        details: `Payment ${row.payment_id} is SUCCEEDED but Booking ${row.booking_id} status is ${row.booking_status}`,
        repaired: false,
      };

      if (!dryRun) {
        try {
          await client.query(
            `UPDATE bookings
             SET status = 'CONFIRMED', updated_at = CURRENT_TIMESTAMP
             WHERE id = $1;`,
            [row.booking_id]
          );
          item.repaired = true;
          item.repairAction = 'Aligned booking status to CONFIRMED';
        } catch (repairErr: unknown) {
          item.error = repairErr instanceof Error ? repairErr.message : String(repairErr);
        }
      }

      discrepancies.push(item);
    }

    // 2. Check for succeeded payments missing an immutable transaction_ledger CHARGE entry
    const missingLedger = await client.query(
      `SELECT p.id as payment_id, p.booking_id, p.amount_minor, p.currency, p.provider_payment_id
       FROM payments p
       LEFT JOIN transaction_ledger tl ON tl.payment_id = p.id AND tl.transaction_type = 'CHARGE'
       WHERE p.status = 'SUCCEEDED' AND tl.id IS NULL
       LIMIT $1;`,
      [batchSize]
    );

    for (const row of missingLedger.rows) {
      const item: DiscrepancyItem = {
        id: crypto.randomUUID(),
        type: 'MISSING_LEDGER_RECORD',
        entityId: row.payment_id,
        details: `Payment ${row.payment_id} is SUCCEEDED but missing an immutable CHARGE ledger entry`,
        repaired: false,
      };

      if (!dryRun) {
        try {
          const ledgerRef = `REF-REC-CHG-${row.provider_payment_id || row.payment_id.slice(0, 8)}`;
          await client.query(
            `INSERT INTO transaction_ledger (
              payment_id, booking_id, transaction_type, amount_minor, currency, reference
            ) VALUES ($1, $2, 'CHARGE', $3, $4, $5);`,
            [row.payment_id, row.booking_id, Number(row.amount_minor), row.currency, ledgerRef]
          );
          item.repaired = true;
          item.repairAction = 'Appended missing immutable CHARGE audit record to transaction_ledger';
        } catch (repairErr: unknown) {
          item.error = repairErr instanceof Error ? repairErr.message : String(repairErr);
        }
      }

      discrepancies.push(item);
    }
  }

  /**
   * Compares PostgreSQL session_seats state with Redis in-memory cache and repairs any drift.
   * PostgreSQL is the absolute source of truth.
   */
  private async reconcileSessionInventory(
    client: pg.PoolClient,
    dryRun: boolean,
    targetSessionIds: string[] | undefined,
    discrepancies: DiscrepancyItem[]
  ): Promise<void> {
    const redis = await getRedisClient();

    // Query active or recent sessions
    const sessionQuery = targetSessionIds && targetSessionIds.length > 0
      ? `SELECT id FROM event_sessions WHERE id = ANY($1);`
      : `SELECT id FROM event_sessions WHERE status IN ('OPEN', 'SCHEDULED') LIMIT 20;`;
    const sessionParams = targetSessionIds && targetSessionIds.length > 0 ? [targetSessionIds] : [];
    const sessionsRes = await client.query<{ id: string }>(sessionQuery, sessionParams);

    for (const session of sessionsRes.rows) {
      const sessionId = session.id;
      const seatsKey = RedisKeys.sessionSeats(sessionId);

      // Fetch all seats in PostgreSQL for this session
      const pgSeatsRes = await client.query<{ id: string; status: string }>(
        `SELECT id, status FROM session_seats WHERE event_session_id = $1;`,
        [sessionId]
      );

      if (pgSeatsRes.rows.length === 0) continue;

      // Fetch Redis hash
      const redisSeats = await redis.hgetall(seatsKey);

      for (const pgSeat of pgSeatsRes.rows) {
        const redisStatus = redisSeats[pgSeat.id];

        // Case A: PostgreSQL is BOOKED, but Redis is NOT BOOKED
        if (pgSeat.status === 'BOOKED' && redisStatus !== 'BOOKED') {
          const item: DiscrepancyItem = {
            id: crypto.randomUUID(),
            type: 'POSTGRES_BOOKED_MISSING_REDIS',
            entityId: pgSeat.id,
            sessionId,
            details: `Seat ${pgSeat.id} is BOOKED in PostgreSQL but '${redisStatus || 'MISSING'}' in Redis`,
            repaired: false,
          };

          if (!dryRun) {
            try {
              await redis.hset(seatsKey, pgSeat.id, 'BOOKED');
              item.repaired = true;
              item.repairAction = 'Updated Redis seat hash to BOOKED';
            } catch (err: unknown) {
              item.error = err instanceof Error ? err.message : String(err);
            }
          }

          discrepancies.push(item);
        }

        // Case B: Redis is BOOKED, but PostgreSQL is AVAILABLE (Orphan Booked state in Redis)
        if (redisStatus === 'BOOKED' && pgSeat.status === 'AVAILABLE') {
          const item: DiscrepancyItem = {
            id: crypto.randomUUID(),
            type: 'REDIS_ORPHAN_BOOKED',
            entityId: pgSeat.id,
            sessionId,
            details: `Seat ${pgSeat.id} is BOOKED in Redis but AVAILABLE in PostgreSQL`,
            repaired: false,
          };

          if (!dryRun) {
            try {
              await redis.hset(seatsKey, pgSeat.id, 'AVAILABLE');
              item.repaired = true;
              item.repairAction = 'Reconciled Redis seat hash back to AVAILABLE matching PostgreSQL';
            } catch (err: unknown) {
              item.error = err instanceof Error ? err.message : String(err);
            }
          }

          discrepancies.push(item);
        }
      }
    }
  }
}
