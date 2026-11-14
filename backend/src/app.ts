import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { env } from './config/env.js';
import { healthRouter } from './routes/health.routes.js';
import { authRouter } from './routes/auth.routes.js';
import { eventsRouter } from './routes/events.routes.js';
import { sessionsRouter } from './routes/sessions.routes.js';
import { reservationsRouter } from './routes/reservations.routes.js';
import { paymentsRouter } from './routes/payments.routes.js';
import { bookingsRouter } from './routes/bookings.routes.js';
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
  app.use(cookieParser());
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));
  app.use(requestLogger);

  // Health check routes
  app.use('/health', healthRouter);
  app.use('/api/health', healthRouter);

  // API v1 Routes
  app.use('/api/v1/auth', authRouter);
  app.use('/api/v1', eventsRouter);
  app.use('/api/v1', sessionsRouter);
  app.use('/api/v1', reservationsRouter);
  app.use('/api/v1', paymentsRouter);
  app.use('/api/v1', bookingsRouter);

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
