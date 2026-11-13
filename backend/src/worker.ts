import { env } from './config/env.js';
import { logger } from './utils/logger.js';
import { BookingConsumer } from './queues/booking.consumer.js';
import { TransactionalOutboxService } from './services/outbox.service.js';
import { closeRabbitMQClient } from './config/rabbitmq.js';
import { closeDbPool } from './config/database.js';
import { closeRedisClient } from './config/redis.js';

let isRunning = true;
let outboxTimer: NodeJS.Timeout | null = null;
const consumer = new BookingConsumer();
const outboxService = new TransactionalOutboxService('worker-outbox-relay');

const startWorker = async (): Promise<void> => {
  logger.info('====================================================');
  logger.info('🛡️  DropShield Asynchronous Booking Worker started');
  logger.info(`Environment: ${env.NODE_ENV}`);
  logger.info(`RabbitMQ target: ${env.RABBITMQ_URL}`);
  logger.info('====================================================');

  // 1. Start RabbitMQ Booking Consumer
  await consumer.start(10);

  // 2. Start Background Outbox Relay Polling Loop
  const pollOutbox = async (): Promise<void> => {
    if (!isRunning) return;
    try {
      await outboxService.processBatch(20);
    } catch (err: unknown) {
      logger.warn('Error during background outbox relay batch:', err);
    }
  };

  outboxTimer = setInterval(pollOutbox, 2000);
  outboxTimer.unref();

  logger.info('Background outbox relay service initialized (polling interval: 2000ms).');
};

const gracefulShutdown = async (signal: string): Promise<void> => {
  logger.info(`Received ${signal}. Gracefully stopping worker consumers and relays...`);
  isRunning = false;

  if (outboxTimer) {
    clearInterval(outboxTimer);
    outboxTimer = null;
  }

  try {
    await consumer.stop();
    await closeRabbitMQClient();
    await closeDbPool();
    await closeRedisClient();
    logger.info('Worker dependencies shut down cleanly. Exiting.');
    process.exit(0);
  } catch (err) {
    logger.error('Error during worker graceful shutdown:', err);
    process.exit(1);
  }
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

startWorker().catch((err) => {
  logger.error('Fatal worker startup error:', err);
  process.exit(1);
});
