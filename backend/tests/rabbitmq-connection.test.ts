import {
  getRabbitMQConnection,
  getRabbitMQConfirmChannel,
  checkRabbitMQHealth,
  sanitizeAmqpUrl,
  closeRabbitMQClient,
} from '../src/config/rabbitmq.js';
import { assertBookingTopology, QUEUE_CONSTANTS } from '../src/queues/topology.js';

describe('DropShield Phase 5: RabbitMQ Connection & Topology Test Suite', () => {
  afterAll(async () => {
    await closeRabbitMQClient();
  });

  describe('1. Sanitization & Resilience', () => {
    it('sanitizes password from AMQP URLs in logs', () => {
      const sensitive = 'amqp://admin:superSecretPassword123@rmq.internal:5672/vhost';
      const sanitized = sanitizeAmqpUrl(sensitive);
      expect(sanitized).not.toContain('superSecretPassword123');
      expect(sanitized).toContain('admin:***@rmq.internal:5672/vhost');
    });

    it('returns healthy status with latency measurement for active broker', async () => {
      const health = await checkRabbitMQHealth();
      expect(health.status).toBe('up');
      expect(typeof health.latencyMs).toBe('number');
      expect(health.latencyMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe('2. Topology Assertion & Confirm Channels', () => {
    it('idempotently asserts all exchanges, queues, and bindings without error', async () => {
      const conn = await getRabbitMQConnection();
      const channel = await conn.createChannel();

      // Should assert cleanly
      await assertBookingTopology(channel);

      // Verify main queue exists
      const mainQueue = await channel.checkQueue(QUEUE_CONSTANTS.QUEUE.BOOKING_REQUESTED);
      expect(mainQueue.queue).toBe(QUEUE_CONSTANTS.QUEUE.BOOKING_REQUESTED);

      // Verify dead-letter queue exists
      const dlq = await channel.checkQueue(QUEUE_CONSTANTS.QUEUE.BOOKING_DEAD);
      expect(dlq.queue).toBe(QUEUE_CONSTANTS.QUEUE.BOOKING_DEAD);

      // Verify retry queues exist
      const retry1 = await channel.checkQueue(QUEUE_CONSTANTS.QUEUE.RETRY_1);
      expect(retry1.queue).toBe(QUEUE_CONSTANTS.QUEUE.RETRY_1);

      await channel.close();
    });

    it('publishes persistent message with publisher confirm', async () => {
      const confirmChannel = await getRabbitMQConfirmChannel();

      const testPayload = Buffer.from(
        JSON.stringify({
          test: true,
          timestamp: new Date().toISOString(),
        })
      );

      const confirmed = await new Promise<boolean>((resolve, reject) => {
        confirmChannel.publish(
          QUEUE_CONSTANTS.EXCHANGE.BOOKING,
          'booking.probe',
          testPayload,
          {
            persistent: true,
            contentType: 'application/json',
          },
          (err) => {
            if (err) reject(err);
            else resolve(true);
          }
        );
      });

      expect(confirmed).toBe(true);
    });
  });
});
