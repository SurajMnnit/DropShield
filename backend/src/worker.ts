import { env } from './config/env.js';
import { logger } from './utils/logger.js';

let isRunning = true;

const startWorker = async (): Promise<void> => {
  logger.info('====================================================');
  logger.info('🛡️  DropShield Asynchronous Booking Worker started');
  logger.info(`Environment: ${env.NODE_ENV}`);
  logger.info(`RabbitMQ target: ${env.RABBITMQ_URL}`);
  logger.info('Awaiting queue integration in Phase 5...');
  logger.info('====================================================');

  // Keep-alive heartbeat simulation until consumers are wired in Phase 5
  const heartbeat = setInterval(() => {
    if (!isRunning) {
      clearInterval(heartbeat);
      return;
    }
    logger.debug('Worker heartbeat: ready for incoming booking events.');
  }, 30000);
};

const gracefulShutdown = (signal: string): void => {
  logger.info(`Received ${signal}. Gracefully stopping worker consumers...`);
  isRunning = false;
  setTimeout(() => {
    logger.info('Worker exited successfully.');
    process.exit(0);
  }, 1000);
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

startWorker().catch((err) => {
  logger.error('Fatal worker startup error:', err);
  process.exit(1);
});
