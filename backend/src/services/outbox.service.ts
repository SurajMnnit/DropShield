import crypto from 'crypto';
import type pg from 'pg';
import { dbPool } from '../config/database.js';
import { getRabbitMQConfirmChannel } from '../config/rabbitmq.js';
import { QUEUE_CONSTANTS } from '../queues/topology.js';
import { logger } from '../utils/logger.js';
import { metrics } from '../utils/metrics.js';

export interface OutboxEventRecord {
  id: string;
  aggregate_type: string;
  aggregate_id: string;
  event_type: string;
  payload: Record<string, unknown> | string;
  status: 'PENDING' | 'PROCESSING' | 'PUBLISHED' | 'FAILED';
  attempts: number;
  max_attempts: number;
  available_at: Date;
  locked_at: Date | null;
  locked_by: string | null;
  last_error: string | null;
  published_at: Date | null;
  created_at: Date;
}

export interface CreateOutboxEventParams {
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  payload: Record<string, unknown>;
  maxAttempts?: number;
}

export class TransactionalOutboxService {
  private publisherId: string;
  private db: pg.Pool | pg.Client;

  constructor(publisherId?: string, db?: pg.Pool | pg.Client) {
    this.publisherId = publisherId || `publisher-${crypto.randomUUID()}`;
    this.db = db || dbPool;
  }

  /**
   * Insert an outbox event within an existing transactional PostgreSQL client.
   * Atomic with the reservation/state write.
   */
  async createOutboxEvent(
    client: pg.PoolClient | pg.Client,
    params: CreateOutboxEventParams
  ): Promise<OutboxEventRecord> {
    const maxAttempts = params.maxAttempts ?? 5;
    const queryText = `
      INSERT INTO outbox_events (
        aggregate_type,
        aggregate_id,
        event_type,
        payload,
        status,
        attempts,
        max_attempts,
        available_at
      ) VALUES ($1, $2, $3, $4, 'PENDING', 0, $5, CURRENT_TIMESTAMP)
      RETURNING *;
    `;

    const res = await client.query<OutboxEventRecord>(queryText, [
      params.aggregateType,
      params.aggregateId,
      params.eventType,
      JSON.stringify(params.payload),
      maxAttempts,
    ]);

    metrics.increment('outbox_created_total');
    return res.rows[0];
  }

  /**
   * Polls and claims unpublished outbox events using FOR UPDATE SKIP LOCKED.
   * Safe across multiple concurrent publisher instances.
   */
  async claimPendingEvents(
    batchSize = 20,
    lockStaleMinutes = 1
  ): Promise<OutboxEventRecord[]> {
    const claimQuery = `
      WITH candidates AS (
        SELECT id FROM outbox_events
        WHERE (status = 'PENDING' AND available_at <= CURRENT_TIMESTAMP)
           OR (status = 'PROCESSING' AND locked_at < CURRENT_TIMESTAMP - ($2 * INTERVAL '1 minute'))
        ORDER BY available_at ASC
        LIMIT $1
        FOR UPDATE SKIP LOCKED
      )
      UPDATE outbox_events
      SET status = 'PROCESSING',
          locked_at = CURRENT_TIMESTAMP,
          locked_by = $3
      FROM candidates
      WHERE outbox_events.id = candidates.id
      RETURNING outbox_events.*;
    `;

    const res = await this.db.query<OutboxEventRecord>(claimQuery, [
      batchSize,
      lockStaleMinutes,
      this.publisherId,
    ]);

    return res.rows;
  }

  /**
   * Publishes a single claimed event to RabbitMQ using ConfirmChannel.
   * Waits for RabbitMQ broker confirmation before marking PUBLISHED in database.
   */
  async publishEvent(event: OutboxEventRecord): Promise<boolean> {
    const channel = await getRabbitMQConfirmChannel();

    const exchange = QUEUE_CONSTANTS.EXCHANGE.BOOKING;
    const routingKey = event.event_type;

    const messageContent = Buffer.from(
      typeof event.payload === 'string' ? event.payload : JSON.stringify(event.payload)
    );

    const publishPromise = new Promise<void>((resolve, reject) => {
      const ok = channel.publish(
        exchange,
        routingKey,
        messageContent,
        {
          persistent: true,
          messageId: event.id,
          timestamp: Date.now(),
          contentType: 'application/json',
          type: event.event_type,
          headers: {
            aggregateType: event.aggregate_type,
            aggregateId: event.aggregate_id,
            attempts: event.attempts,
          },
        },
        (err) => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        }
      );

      if (!ok) {
        channel.once('drain', () => {
          // Channel buffer cleared
        });
      }
    });

    try {
      // Publish with timeout safeguard
      await Promise.race([
        publishPromise,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('RabbitMQ publish confirm timeout')), 5000)
        ),
      ]);

      // Successfully confirmed by RabbitMQ broker -> update database status
      await this.db.query(
        `
        UPDATE outbox_events
        SET status = 'PUBLISHED',
            published_at = CURRENT_TIMESTAMP,
            locked_at = NULL,
            locked_by = NULL
        WHERE id = $1;
        `,
        [event.id]
      );

      metrics.increment('outbox_published_total');
      logger.info(`Outbox event published and confirmed: ${event.id} [${event.event_type}]`);
      return true;
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error(`Outbox publish failed for event ${event.id}:`, errMsg);

      metrics.increment('outbox_publish_failed_total');

      const nextAttempt = event.attempts + 1;
      const delaySeconds = Math.min(Math.pow(2, nextAttempt), 300); // Exponential backoff up to 5 min
      const isPermanentlyFailed = nextAttempt >= event.max_attempts;

      await this.db.query(
        `
        UPDATE outbox_events
        SET attempts = $1,
            status = $2,
            available_at = CURRENT_TIMESTAMP + ($3 * INTERVAL '1 second'),
            locked_at = NULL,
            locked_by = NULL,
            last_error = $4
        WHERE id = $5;
        `,
        [
          nextAttempt,
          isPermanentlyFailed ? 'FAILED' : 'PENDING',
          delaySeconds,
          errMsg,
          event.id,
        ]
      );

      return false;
    }
  }

  /**
   * Process a batch of pending outbox events.
   */
  async processBatch(batchSize = 20): Promise<{ claimed: number; published: number; failed: number }> {
    if ((this.db as any).ended) {
      return { claimed: 0, published: 0, failed: 0 };
    }
    const events = await this.claimPendingEvents(batchSize);
    let published = 0;
    let failed = 0;

    for (const event of events) {
      const success = await this.publishEvent(event);
      if (success) {
        published++;
      } else {
        failed++;
      }
    }

    return {
      claimed: events.length,
      published,
      failed,
    };
  }
}
