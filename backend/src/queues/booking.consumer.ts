import type amqp from 'amqplib';
import { dbPool } from '../config/database.js';
import { getRabbitMQConnection } from '../config/rabbitmq.js';
import { QUEUE_CONSTANTS, assertBookingTopology } from './topology.js';
import { RedisInventoryService } from '../services/inventory.service.js';
import { logger } from '../utils/logger.js';
import { metrics } from '../utils/metrics.js';
import type { BookingRequestedEvent } from '@dropshield/shared';

const inventoryService = new RedisInventoryService();

export class BookingConsumer {
  private channel: amqp.Channel | null = null;
  private isRunning = false;
  private consumerTag: string | null = null;

  async start(prefetchCount = 10): Promise<void> {
    if (this.isRunning) return;

    const conn = await getRabbitMQConnection();
    const ch = await conn.createChannel();
    this.channel = ch;

    // Ensure topology exists
    await assertBookingTopology(ch);

    // Bounded prefetch to prevent uncontrolled concurrency
    await ch.prefetch(prefetchCount);

    logger.info(`Booking consumer starting on queue '${QUEUE_CONSTANTS.QUEUE.BOOKING_REQUESTED}' (prefetch: ${prefetchCount})...`);

    const { consumerTag } = await ch.consume(
      QUEUE_CONSTANTS.QUEUE.BOOKING_REQUESTED,
      async (msg) => {
        if (!msg) return;
        await this.handleMessage(msg);
      },
      { noAck: false } // Manual consumer acknowledgements
    );

    this.consumerTag = consumerTag;
    this.isRunning = true;
    logger.info(`Booking consumer active [tag: ${consumerTag}]`);
  }

  async stop(): Promise<void> {
    if (!this.isRunning || !this.channel) return;
    this.isRunning = false;
    try {
      if (this.consumerTag) {
        await this.channel.cancel(this.consumerTag);
      }
      await this.channel.close();
      this.channel = null;
      logger.info('Booking consumer stopped gracefully.');
    } catch (err) {
      logger.warn('Error closing booking consumer channel:', err);
    }
  }

  /**
   * Processes a single incoming booking message with strict transactional boundaries.
   */
  async handleMessage(msg: amqp.ConsumeMessage): Promise<void> {
    const startTime = Date.now();
    metrics.increment('worker_messages_consumed_total');

    let event: BookingRequestedEvent;
    try {
      const rawContent = msg.content.toString('utf-8');
      event = JSON.parse(rawContent);

      // Validate message structure and event version
      if (!event || event.eventType !== 'booking.requested' || event.version !== 'v1' || !event.payload) {
        throw new Error(`Invalid event format or unsupported version: ${event?.version}`);
      }
    } catch (parseErr: unknown) {
      const errMessage = parseErr instanceof Error ? parseErr.message : String(parseErr);
      logger.error('Failed to parse or validate booking message. Routing directly to DLQ:', errMessage);
      metrics.increment('worker_invalid_message_total');

      // Permanent parse error: reject without requeue (DLX routes to DLQ)
      this.channel?.reject(msg, false);
      return;
    }

    const { reservationId, sessionId, userId, seatIds, expiresAt } = event.payload;

    try {
      // 1. Check if reservation lease has already expired
      const expiryTimestamp = new Date(expiresAt).getTime();
      const now = Date.now();

      if (now >= expiryTimestamp) {
        logger.warn(`Reservation ${reservationId} expired while in queue. Reclaiming inventory...`);
        metrics.increment('worker_reservation_expired_in_queue_total');

        // Mark expired in database if not already updated
        await dbPool.query(
          `UPDATE reservations
           SET status = 'EXPIRED', updated_at = CURRENT_TIMESTAMP
           WHERE id = $1 AND status = 'PENDING';`,
          [reservationId]
        );

        // Release seats back to AVAILABLE in Redis
        await inventoryService.releaseSeats({
          sessionId,
          reservationId,
          userId,
          reason: 'EXPIRED',
        });

        // Acknowledge message: processing complete
        this.channel?.ack(msg);
        return;
      }

      // 2. Load reservation from PostgreSQL and check current state
      const resCheck = await dbPool.query(
        `SELECT id, user_id, event_session_id, status, expires_at, total_amount_minor 
         FROM reservations 
         WHERE id = $1;`,
        [reservationId]
      );

      if (resCheck.rows.length === 0) {
        logger.warn(`Reservation ${reservationId} not found in database. Dead-lettering message.`);
        this.channel?.reject(msg, false);
        return;
      }

      const reservationRecord = resCheck.rows[0];

      // Idempotency check: If already processed (not PENDING), handle duplicate delivery cleanly
      if (reservationRecord.status !== 'PENDING') {
        logger.info(`Reservation ${reservationId} is already in state '${reservationRecord.status}'. Duplicate delivery ignored.`);
        metrics.increment('worker_duplicate_delivery_total');
        this.channel?.ack(msg);
        return;
      }

      // 3. Execute PostgreSQL transaction: Verify seats integrity and advance booking intake
      const client = await dbPool.connect();
      try {
        await client.query('BEGIN');

        // Verify session seats are held by this reservation
        const seatsQuery = await client.query(
          `SELECT id, status, current_reservation_id, price_minor 
           FROM session_seats 
           WHERE event_session_id = $1 AND id = ANY($2)
           FOR UPDATE;`,
          [sessionId, seatIds]
        );

        // Ensure all seats belong to this reservation
        const allSeatsHeld = seatsQuery.rows.every(
          (s: { status: string; current_reservation_id: string }) =>
            s.status === 'HELD' && s.current_reservation_id === reservationId
        );

        if (!allSeatsHeld) {
          logger.warn(`Seat integrity mismatch for reservation ${reservationId}. Aborting intake.`);
          await client.query('ROLLBACK');
          this.channel?.reject(msg, false);
          return;
        }

        // Record audit / intake validation stamp without prematurely marking CONFIRMED
        // (Reservation remains PENDING until payment processing in Phase 6)
        await client.query(
          `UPDATE reservations
           SET updated_at = CURRENT_TIMESTAMP
           WHERE id = $1 AND status = 'PENDING';`,
          [reservationId]
        );

        await client.query('COMMIT');
      } catch (dbErr) {
        await client.query('ROLLBACK');
        throw dbErr;
      } finally {
        client.release();
      }

      // 4. Acknowledge the RabbitMQ message ONLY AFTER the database transaction commits!
      this.channel?.ack(msg);

      const processingDuration = Date.now() - startTime;
      metrics.recordTiming('worker_processing_duration_ms', processingDuration);
      metrics.increment('worker_messages_processed_total');
      logger.info(`Successfully processed booking request for reservation ${reservationId} [${processingDuration}ms]`);
    } catch (processErr: unknown) {
      const errMsg = processErr instanceof Error ? processErr.message : String(processErr);
      logger.error(`Error processing booking message for reservation ${reservationId}:`, errMsg);

      metrics.increment('worker_processing_errors_total');

      // Bounded retry with backoff using topology retry queues
      await this.handleFailureWithRetry(msg, event);
    }
  }

  /**
   * Routes failed messages to progressive delay retry queues or dead-letter queue.
   */
  private async handleFailureWithRetry(
    msg: amqp.ConsumeMessage,
    event: BookingRequestedEvent
  ): Promise<void> {
    if (!this.channel) return;

    const currentRetry = (msg.properties.headers?.['x-retry-count'] as number) || (event.retryCount || 0);

    if (currentRetry < QUEUE_CONSTANTS.MAX_RETRIES) {
      const nextRetry = currentRetry + 1;
      const retryRoutingKey = `${QUEUE_CONSTANTS.ROUTING_KEY.RETRY_PREFIX}.${nextRetry}`;

      logger.warn(`Retrying reservation ${event.payload?.reservationId} (attempt ${nextRetry}/${QUEUE_CONSTANTS.MAX_RETRIES}) via '${retryRoutingKey}'`);
      metrics.increment('worker_message_retried_total');

      event.retryCount = nextRetry;

      this.channel.publish(
        QUEUE_CONSTANTS.EXCHANGE.RETRY,
        retryRoutingKey,
        Buffer.from(JSON.stringify(event)),
        {
          persistent: true,
          headers: {
            ...msg.properties.headers,
            'x-retry-count': nextRetry,
          },
        }
      );

      // Ack original message from current queue
      this.channel.ack(msg);
    } else {
      logger.error(`Reservation ${event.payload?.reservationId} exceeded max retries (${QUEUE_CONSTANTS.MAX_RETRIES}). Routing to DLQ.`);
      metrics.increment('worker_dead_lettered_total');

      // Send to Dead-Letter Queue
      this.channel.publish(
        QUEUE_CONSTANTS.EXCHANGE.DLX,
        QUEUE_CONSTANTS.ROUTING_KEY.BOOKING_DEAD,
        msg.content,
        {
          persistent: true,
          headers: {
            ...msg.properties.headers,
            'x-death-reason': 'MAX_RETRIES_EXCEEDED',
          },
        }
      );

      // Ack original message
      this.channel.ack(msg);
    }
  }
}
