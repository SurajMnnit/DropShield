import { Redis, type RedisOptions } from 'ioredis';
import { env } from './env.js';
import { logger } from '../utils/logger.js';

let redisInstance: Redis | null = null;

/**
 * Build standard RedisOptions from environment configuration.
 * Never includes credentials in log messages.
 */
export function buildRedisConfig(overrides: Partial<RedisOptions> = {}): RedisOptions {
  const options: RedisOptions = {
    host: env.REDIS_HOST,
    port: env.REDIS_PORT,
    connectTimeout: env.REDIS_CONNECT_TIMEOUT_MS,
    commandTimeout: env.REDIS_COMMAND_TIMEOUT_MS,
    lazyConnect: true,
    maxRetriesPerRequest: 3,
    retryStrategy(times: number) {
      if (times > 10) {
        logger.error(`Redis reconnection failed after ${times} attempts. Halting auto-retry.`);
        return null;
      }
      const delay = Math.min(times * 150, env.REDIS_RETRY_MAX_DELAY_MS);
      logger.warn(`Redis disconnected. Reconnecting in ${delay}ms (attempt #${times})...`);
      return delay;
    },
    ...overrides,
  };

  if (env.REDIS_PASSWORD) {
    options.password = env.REDIS_PASSWORD;
  }
  if (env.REDIS_USERNAME) {
    options.username = env.REDIS_USERNAME;
  }
  if (env.REDIS_TLS) {
    options.tls = { rejectUnauthorized: true };
  }

  return options;
}

/**
 * Creates a standalone configured Redis client.
 */
export function createRedisClient(overrides: Partial<RedisOptions> = {}): Redis {
  const config = buildRedisConfig(overrides);
  const client = new Redis(config);

  client.on('connect', () => {
    logger.info(`Redis client connecting to ${config.host}:${config.port}...`);
  });

  client.on('ready', () => {
    logger.info(`Redis client ready and accepting commands.`);
  });

  client.on('error', (err: Error) => {
    // Sanitized logging: log error message, never credentials
    logger.error('Redis client error:', err.message);
  });

  client.on('close', () => {
    logger.info('Redis connection closed.');
  });

  client.on('reconnecting', (delay: number) => {
    logger.warn(`Redis client reconnecting in ${delay}ms...`);
  });

  return client;
}

/**
 * Returns the singleton Redis client instance, lazily connecting if needed.
 */
export async function getRedisClient(): Promise<Redis> {
  if (!redisInstance) {
    redisInstance = createRedisClient();
    await redisInstance.connect();
  } else if (redisInstance.status === 'wait' || redisInstance.status === 'close') {
    await redisInstance.connect();
  }
  return redisInstance;
}

/**
 * Perform a live Redis health probe with latency measurement.
 */
export async function checkRedisHealth(client?: Redis): Promise<{
  status: 'up' | 'down';
  latencyMs?: number;
  error?: string;
}> {
  const r = client || (await getRedisClient().catch(() => null));
  if (!r) {
    return { status: 'down', error: 'Redis client unavailable' };
  }

  const start = Date.now();
  try {
    const pong = await r.ping();
    const latencyMs = Date.now() - start;
    if (pong === 'PONG') {
      return { status: 'up', latencyMs };
    }
    return { status: 'down', latencyMs, error: `Unexpected PING response: ${pong}` };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { status: 'down', error: msg };
  }
}

/**
 * Graceful shutdown for Redis connection pool/client.
 */
export async function closeRedisClient(client?: Redis): Promise<void> {
  const target = client || redisInstance;
  if (!target) return;

  target.removeAllListeners();
  try {
    let timer: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('timeout')), 500);
      timer.unref();
    });
    try {
      await Promise.race([target.quit(), timeoutPromise]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  } catch {
    target.disconnect(false);
  } finally {
    if (!client || client === redisInstance) {
      redisInstance = null;
    }
  }
}
