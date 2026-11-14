import type amqp from 'amqplib';
import { dbPool } from '../config/database.js';
import { getRabbitMQConnection } from '../config/rabbitmq.js';
import { QUEUE_CONSTANTS } from '../queues/topology.js';
import { logger } from '../utils/logger.js';
import { metrics } from '../utils/metrics.js';
import type { BookingRequestedEvent } from '@dropshield/shared';

export interface DLQInspectionItem {
  messageId?: string;
  reservationId?: string;
  eventType?: string;
  deathReason?: string;
  deathCount?: number;
  originalQueue?: string;
  eligibleForReplay: boolean;
  reservationStatus?: string;
  payloadSummary?: string;
}

export interface DLQInspectionReport {
  queue: string;
  totalMessages: number;
  inspectedCount: number;
  items: DLQInspectionItem[];
}

export interface DLQReplayReport {
  totalProcessed: number;
  replayedCount: number;
  discardedDuplicatesCount: number;
  discardedExpiredCount: number;
  failedCount: number;
}

export class DeadLetterService {
  /**
   * Inspect dead-letter queue without acknowledging or modifying messages.
   */
  async inspectDeadLetterQueue(maxMessages = 50): Promise<DLQInspectionReport> {
    const conn = await getRabbitMQConnection();
    const ch = await conn.createChannel();

    try {
      const qInfo = await ch.checkQueue(QUEUE_CONSTANTS.QUEUE.BOOKING_DEAD);
      const totalMessages = qInfo.messageCount;
      const items: DLQInspectionItem[] = [];

      // We read up to maxMessages using basic.get and requeue them immediately (or reject with requeue)
      // to keep inspection non-destructive.
      let count = 0;
      while (count < maxMessages && count < totalMessages) {
        const msg = await ch.get(QUEUE_CONSTANTS.QUEUE.BOOKING_DEAD, { noAck: false });
        if (!msg) break;

        count++;
        const item = await this.analyzeMessage(msg);
        items.push(item);

        // Requeue immediately to keep inspection read-only
        ch.nack(msg, false, true);
      }

      metrics.setGauge('dlq_messages_count', totalMessages);

      return {
        queue: QUEUE_CONSTANTS.QUEUE.BOOKING_DEAD,
        totalMessages,
        inspectedCount: items.length,
        items,
      };
    } finally {
      await ch.close().catch(() => {});
    }
  }

  /**
   * Safely replay eligible dead-lettered messages.
   * Guarantees idempotency: Checks PostgreSQL status first.
   * If reservation is already CONFIRMED or EXPIRED, purges from DLQ without re-dispatching.
   */
  async replayDeadLetterMessages(batchSize = 20): Promise<DLQReplayReport> {
    const conn = await getRabbitMQConnection();
    const ch = await conn.createChannel();

    const report: DLQReplayReport = {
      totalProcessed: 0,
      replayedCount: 0,
      discardedDuplicatesCount: 0,
      discardedExpiredCount: 0,
      failedCount: 0,
    };

    try {
      let processed = 0;
      while (processed < batchSize) {
        const msg = await ch.get(QUEUE_CONSTANTS.QUEUE.BOOKING_DEAD, { noAck: false });
        if (!msg) break;

        processed++;
        report.totalProcessed++;

        try {
          const rawContent = msg.content.toString('utf-8');
          let event: BookingRequestedEvent;

          try {
            event = JSON.parse(rawContent);
          } catch {
            // Unparseable JSON: permanent poison pill
            logger.warn('DLQ message has unparseable content. Discarding to avoid infinite loop.');
            ch.ack(msg);
            report.failedCount++;
            continue;
          }

          const reservationId = event?.payload?.reservationId;
          if (!reservationId) {
            ch.ack(msg);
            report.failedCount++;
            continue;
          }

          // Check current PostgreSQL durable state
          const resCheck = await dbPool.query(
            `SELECT id, status, expires_at FROM reservations WHERE id = $1;`,
            [reservationId]
          );

          if (resCheck.rows.length === 0) {
            logger.warn(`DLQ reservation ${reservationId} no longer exists in PostgreSQL. Discarding.`);
            ch.ack(msg);
            report.failedCount++;
            continue;
          }

          const resRecord = resCheck.rows[0];

          // 1. If already CONFIRMED: Message is redundant
          if (resRecord.status === 'CONFIRMED') {
            logger.info(`DLQ reservation ${reservationId} is already CONFIRMED. Purging message.`);
            ch.ack(msg);
            report.discardedDuplicatesCount++;
            continue;
          }

          // 2. If already EXPIRED or past lease time: Do not resurrect
          const isExpired = resRecord.status === 'EXPIRED' || new Date() >= new Date(resRecord.expires_at);
          if (isExpired) {
            logger.info(`DLQ reservation ${reservationId} is already EXPIRED. Purging message.`);
            ch.ack(msg);
            report.discardedExpiredCount++;
            continue;
          }

          // 3. Eligible for replay: Publish back to main booking queue with fresh trace header
          const currentRetries = (msg.properties.headers?.['x-replay-count'] as number) || 0;
          if (currentRetries >= 3) {
            logger.warn(`DLQ reservation ${reservationId} exceeded maximum replay quota (3). Leaving in DLQ.`);
            ch.nack(msg, false, true);
            report.failedCount++;
            continue;
          }

          ch.publish(
            QUEUE_CONSTANTS.EXCHANGE.BOOKING,
            QUEUE_CONSTANTS.ROUTING_KEY.BOOKING_REQUESTED,
            msg.content,
            {
              persistent: true,
              headers: {
                ...msg.properties.headers,
                'x-replay-count': currentRetries + 1,
                'x-replayed-at': new Date().toISOString(),
              },
            }
          );

          // Acknowledge the old dead-letter message
          ch.ack(msg);
          report.replayedCount++;
          metrics.increment('dlq_replayed_total');
          logger.info(`Replayed dead-letter message for reservation ${reservationId} (replay #${currentRetries + 1})`);
        } catch (msgErr: unknown) {
          const msg = msgErr instanceof Error ? msgErr.message : String(msgErr);
          logger.error('Error replaying DLQ message:', msg);
          report.failedCount++;
        }
      }

      return report;
    } finally {
      await ch.close().catch(() => {});
    }
  }

  private async analyzeMessage(msg: amqp.GetMessage): Promise<DLQInspectionItem> {
    try {
      const rawContent = msg.content.toString('utf-8');
      const event: BookingRequestedEvent = JSON.parse(rawContent);
      const reservationId = event?.payload?.reservationId;

      const deathHeader = msg.properties.headers?.['x-death'];
      let deathReason = 'unknown';
      let deathCount = 0;
      let originalQueue = '';

      if (Array.isArray(deathHeader) && deathHeader.length > 0) {
        deathReason = deathHeader[0].reason || 'rejected';
        deathCount = deathHeader[0].count || 1;
        originalQueue = deathHeader[0].queue || '';
      }

      let reservationStatus = 'NOT_FOUND';
      let eligibleForReplay = false;

      if (reservationId) {
        const resCheck = await dbPool.query(
          `SELECT status, expires_at FROM reservations WHERE id = $1;`,
          [reservationId]
        );
        if (resCheck.rows.length > 0) {
          reservationStatus = resCheck.rows[0].status;
          const isNotExpired = new Date() < new Date(resCheck.rows[0].expires_at);
          eligibleForReplay = reservationStatus === 'PENDING' && isNotExpired;
        }
      }

      return {
        messageId: msg.properties.messageId,
        reservationId,
        eventType: event?.eventType,
        deathReason,
        deathCount,
        originalQueue,
        eligibleForReplay,
        reservationStatus,
        payloadSummary: `Session: ${event?.payload?.sessionId}, Seats: ${event?.payload?.seatIds?.length || 0}`,
      };
    } catch {
      return {
        deathReason: 'unparseable_json',
        eligibleForReplay: false,
      };
    }
  }
}
