import type amqp from 'amqplib';
import { logger } from '../utils/logger.js';

export const QUEUE_CONSTANTS = {
  EXCHANGE: {
    BOOKING: 'dropshield.booking',
    DLX: 'dropshield.booking.dlx',
    RETRY: 'dropshield.booking.retry',
  },
  ROUTING_KEY: {
    BOOKING_REQUESTED: 'booking.requested',
    BOOKING_DEAD: 'booking.dead',
    RETRY_PREFIX: 'booking.retry',
  },
  QUEUE: {
    BOOKING_REQUESTED: 'dropshield.booking.requested',
    BOOKING_DEAD: 'dropshield.booking.dead',
    RETRY_1: 'dropshield.booking.retry.1',
    RETRY_2: 'dropshield.booking.retry.2',
    RETRY_3: 'dropshield.booking.retry.3',
  },
  RETRY_DELAYS_MS: {
    1: 2000,   // 2s delay
    2: 5000,   // 5s delay
    3: 10000,  // 10s delay
  },
  MAX_RETRIES: 3,
} as const;

/**
 * Idempotently asserts the entire RabbitMQ exchange, queue, and binding topology.
 */
export async function assertBookingTopology(channel: amqp.Channel): Promise<void> {
  logger.info('Asserting RabbitMQ booking topology...');

  // 1. Assert Dead-Letter Exchange (DLX) and Dead-Letter Queue (DLQ)
  await channel.assertExchange(QUEUE_CONSTANTS.EXCHANGE.DLX, 'direct', {
    durable: true,
  });

  await channel.assertQueue(QUEUE_CONSTANTS.QUEUE.BOOKING_DEAD, {
    durable: true,
  });

  await channel.bindQueue(
    QUEUE_CONSTANTS.QUEUE.BOOKING_DEAD,
    QUEUE_CONSTANTS.EXCHANGE.DLX,
    QUEUE_CONSTANTS.ROUTING_KEY.BOOKING_DEAD
  );

  // 2. Assert Retry Exchange and Delay Queues (TTL + Dead Letter to Main Exchange)
  await channel.assertExchange(QUEUE_CONSTANTS.EXCHANGE.RETRY, 'direct', {
    durable: true,
  });

  // Retry level 1 (2s)
  await channel.assertQueue(QUEUE_CONSTANTS.QUEUE.RETRY_1, {
    durable: true,
    deadLetterExchange: QUEUE_CONSTANTS.EXCHANGE.BOOKING,
    deadLetterRoutingKey: QUEUE_CONSTANTS.ROUTING_KEY.BOOKING_REQUESTED,
    messageTtl: QUEUE_CONSTANTS.RETRY_DELAYS_MS[1],
  });
  await channel.bindQueue(
    QUEUE_CONSTANTS.QUEUE.RETRY_1,
    QUEUE_CONSTANTS.EXCHANGE.RETRY,
    `${QUEUE_CONSTANTS.ROUTING_KEY.RETRY_PREFIX}.1`
  );

  // Retry level 2 (5s)
  await channel.assertQueue(QUEUE_CONSTANTS.QUEUE.RETRY_2, {
    durable: true,
    deadLetterExchange: QUEUE_CONSTANTS.EXCHANGE.BOOKING,
    deadLetterRoutingKey: QUEUE_CONSTANTS.ROUTING_KEY.BOOKING_REQUESTED,
    messageTtl: QUEUE_CONSTANTS.RETRY_DELAYS_MS[2],
  });
  await channel.bindQueue(
    QUEUE_CONSTANTS.QUEUE.RETRY_2,
    QUEUE_CONSTANTS.EXCHANGE.RETRY,
    `${QUEUE_CONSTANTS.ROUTING_KEY.RETRY_PREFIX}.2`
  );

  // Retry level 3 (10s)
  await channel.assertQueue(QUEUE_CONSTANTS.QUEUE.RETRY_3, {
    durable: true,
    deadLetterExchange: QUEUE_CONSTANTS.EXCHANGE.BOOKING,
    deadLetterRoutingKey: QUEUE_CONSTANTS.ROUTING_KEY.BOOKING_REQUESTED,
    messageTtl: QUEUE_CONSTANTS.RETRY_DELAYS_MS[3],
  });
  await channel.bindQueue(
    QUEUE_CONSTANTS.QUEUE.RETRY_3,
    QUEUE_CONSTANTS.EXCHANGE.RETRY,
    `${QUEUE_CONSTANTS.ROUTING_KEY.RETRY_PREFIX}.3`
  );

  // 3. Assert Main Booking Exchange and Queue
  await channel.assertExchange(QUEUE_CONSTANTS.EXCHANGE.BOOKING, 'topic', {
    durable: true,
  });

  await channel.assertQueue(QUEUE_CONSTANTS.QUEUE.BOOKING_REQUESTED, {
    durable: true,
    deadLetterExchange: QUEUE_CONSTANTS.EXCHANGE.DLX,
    deadLetterRoutingKey: QUEUE_CONSTANTS.ROUTING_KEY.BOOKING_DEAD,
  });

  await channel.bindQueue(
    QUEUE_CONSTANTS.QUEUE.BOOKING_REQUESTED,
    QUEUE_CONSTANTS.EXCHANGE.BOOKING,
    QUEUE_CONSTANTS.ROUTING_KEY.BOOKING_REQUESTED
  );

  logger.info('RabbitMQ booking topology successfully asserted and verified.');
}
