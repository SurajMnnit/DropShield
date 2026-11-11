import { Router } from 'express';
import type { Request, Response } from 'express';
import { env } from '../config/env.js';
import type { HealthResponse } from '@dropshield/shared';

export const healthRouter = Router();

healthRouter.get('/', (_req: Request, res: Response) => {
  const healthData: HealthResponse = {
    status: 'healthy',
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
    environment: env.NODE_ENV,
    version: '1.0.0',
    services: {
      database: 'up',
      redis: 'up',
      rabbitmq: 'up',
    },
  };

  res.status(200).json(healthData);
});
