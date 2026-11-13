import { Router } from 'express';
import type { Request, Response } from 'express';
import { env } from '../config/env.js';
import { dbPool } from '../config/database.js';
import { checkRedisHealth } from '../config/redis.js';
import { checkRabbitMQHealth } from '../config/rabbitmq.js';
import type { HealthResponse } from '@dropshield/shared';

export const healthRouter = Router();

healthRouter.get('/', async (_req: Request, res: Response) => {
  // Concurrent health checks
  const [dbResult, redisResult, rmqResult] = await Promise.allSettled([
    dbPool.query('SELECT 1 as probe;'),
    checkRedisHealth(),
    checkRabbitMQHealth(),
  ]);

  const dbStatus = dbResult.status === 'fulfilled' ? 'up' : 'down';
  const redisStatus = redisResult.status === 'fulfilled' && redisResult.value.status === 'up' ? 'up' : 'down';
  const rmqStatus = rmqResult.status === 'fulfilled' && rmqResult.value.status === 'up' ? 'up' : 'down';

  const isDegraded = dbStatus === 'down' || redisStatus === 'down' || rmqStatus === 'down';

  const healthData: HealthResponse = {
    status: isDegraded ? 'degraded' : 'healthy',
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
    environment: env.NODE_ENV,
    version: '1.0.0',
    services: {
      database: dbStatus,
      redis: redisStatus,
      rabbitmq: rmqStatus,
    },
  };

  const statusCode = isDegraded ? 503 : 200;
  res.status(statusCode).json(healthData);
});
