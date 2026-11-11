import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { env } from './config/env.js';
import { healthRouter } from './routes/health.routes.js';
import { errorHandler } from './middleware/errorHandler.js';
import { requestLogger } from './middleware/requestLogger.js';

export const createApp = (): express.Application => {
  const app = express();

  // Core security and parsing middlewares
  app.use(helmet());
  app.use(
    cors({
      origin: env.CORS_ORIGIN,
      credentials: true,
    })
  );
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));
  app.use(requestLogger);

  // Health check routes
  app.use('/health', healthRouter);
  app.use('/api/health', healthRouter);

  // Root welcome route
  app.get('/', (_req, res) => {
    res.json({
      name: 'DropShield High-Concurrency Booking Engine API',
      status: 'online',
      version: '1.0.0',
      docs: '/docs',
      health: '/health',
    });
  });

  // 404 Handler
  app.use((_req, res) => {
    res.status(404).json({
      success: false,
      error: {
        message: 'Endpoint not found',
      },
      timestamp: new Date().toISOString(),
    });
  });

  // Global Error Handler
  app.use(errorHandler);

  return app;
};
