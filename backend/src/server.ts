import { createApp } from './app.js';
import { env } from './config/env.js';
import { logger } from './utils/logger.js';
import type { Server } from 'http';

const app = createApp();

const server: Server = app.listen(env.PORT, () => {
  logger.info(`🚀 DropShield API Server running on port ${env.PORT} [${env.NODE_ENV}]`);
  logger.info(`📡 Health Check: http://localhost:${env.PORT}/health`);
});

// Graceful shutdown handling
const gracefulShutdown = (signal: string): void => {
  logger.info(`Received ${signal}. Shutting down HTTP server gracefully...`);
  server.close(() => {
    logger.info('HTTP server closed. Exiting process.');
    process.exit(0);
  });

  // Force shutdown after 10 seconds timeout
  setTimeout(() => {
    logger.error('Forcefully terminating process after shutdown timeout.');
    process.exit(1);
  }, 10000).unref();
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

export default server;
