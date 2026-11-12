import pg from 'pg';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

const { Pool } = pg;

function createPoolConfig(connectionString: string, isPooledRuntime = true): pg.PoolConfig {
  const needsSsl = connectionString.includes('sslmode=require') || 
                    connectionString.includes('neon.tech') || 
                    env.NODE_ENV === 'production';

  return {
    connectionString,
    ssl: needsSsl ? { rejectUnauthorized: true } : false,
    max: isPooledRuntime ? env.DB_POOL_MAX : 5,
    min: isPooledRuntime ? env.DB_POOL_MIN : 1,
    connectionTimeoutMillis: env.DB_CONNECTION_TIMEOUT_MS,
    idleTimeoutMillis: env.DB_IDLE_TIMEOUT_MS,
  };
}

// Runtime application pool uses DATABASE_URL (pooled endpoint on Neon)
// Runtime pool uses DATABASE_URL (pooled endpoint on Neon) with strict TLS verification
export const dbPool = new Pool(createPoolConfig(env.DATABASE_URL, true));


dbPool.on('error', (err) => {
  logger.error('Unexpected idle client error on database pool:', err.message);
});

/**
 * Execute a parameterized query against the database pool.
 * Never logs credentials or secrets.
 */
export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: unknown[]
): Promise<pg.QueryResult<T>> {
  const start = Date.now();
  try {
    const res = await dbPool.query<T>(text, params);
    const duration = Date.now() - start;
    if (env.NODE_ENV === 'development' && duration > 500) {
      logger.warn(`Slow query executed (${duration}ms): ${text.slice(0, 100)}...`);
    }
    return res;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('Database query error:', message);
    throw error;
  }
}

/**
 * Gracefully close the database pool
 */
export async function closeDbPool(): Promise<void> {
  logger.info('Closing database connection pool...');
  await dbPool.end();
  logger.info('Database connection pool closed.');
}

/**
 * Creates a direct unpooled client for migrations or advisory lock management.
 * Uses DIRECT_DATABASE_URL if configured, otherwise falls back to DATABASE_URL.
 */
export function createDirectClient(): pg.Client {
  const connectionUrl = env.DIRECT_DATABASE_URL || env.DATABASE_URL;
  const needsSsl = connectionUrl.includes('sslmode=require') || 
                    connectionUrl.includes('neon.tech') || 
                    env.NODE_ENV === 'production';

  return new pg.Client({
    connectionString: connectionUrl,
    ssl: needsSsl ? { rejectUnauthorized: true } : false,
    connectionTimeoutMillis: env.DB_CONNECTION_TIMEOUT_MS,
  });
}

/**
 * Asserts that a given connection URL strictly satisfies disposable test database criteria.
 * Rejects production, primary, missing, or improperly designated targets.
 */
export function assertTestDatabaseUrl(url: string | undefined): void {
  if (!url || typeof url !== 'string' || url.trim() === '') {
    throw new Error('TEST_DATABASE_URL environment variable is required for integration tests');
  }

  // Reject if matches primary DATABASE_URL or DIRECT_DATABASE_URL
  if (process.env.DATABASE_URL && url.trim() === process.env.DATABASE_URL.trim()) {
    throw new Error('TEST_DATABASE_URL cannot match the primary DATABASE_URL');
  }
  if (process.env.DIRECT_DATABASE_URL && url.trim() === process.env.DIRECT_DATABASE_URL.trim()) {
    throw new Error('TEST_DATABASE_URL cannot match the DIRECT_DATABASE_URL');
  }

  try {
    const parsed = new URL(url);
    const dbName = parsed.pathname.replace(/^\//, '').trim();
    if (!dbName) {
      throw new Error('TEST_DATABASE_URL must specify a target database name');
    }

    const lowerDb = dbName.toLowerCase();
    const rejectedNames = ['production', 'prod', 'dropshield', 'main', 'master', 'postgres'];
    if (rejectedNames.includes(lowerDb)) {
      throw new Error(`TEST_DATABASE_URL cannot point to primary or production database: '${dbName}'`);
    }

    if (!lowerDb.includes('test')) {
      throw new Error(`TEST_DATABASE_URL database name '${dbName}' must be explicitly designated as a test database (e.g. dropshield_test)`);
    }
  } catch (err: any) {
    if (err.message && (err.message.startsWith('TEST_DATABASE_URL') || err.message.startsWith('Integration tests'))) {
      throw err;
    }
    throw new Error(`Invalid TEST_DATABASE_URL format: ${err.message}`);
  }
}

