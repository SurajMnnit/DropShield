import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

// Compute SHA-256 checksum for a migration file.
export function computeChecksum(filePath: string): string {
  const fileContent = fs.readFileSync(filePath, 'utf8');
  return crypto.createHash('sha256').update(fileContent, 'utf8').digest('hex');
}

import pg from 'pg';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// Support running from monorepo root or backend directory
export const MIGRATIONS_DIR = fs.existsSync(path.resolve(__dirname, '../../../database/migrations'))
  ? path.resolve(__dirname, '../../../database/migrations')
  : fs.existsSync(path.resolve(__dirname, '../../database/migrations'))
    ? path.resolve(__dirname, '../../database/migrations')
    : path.resolve(process.cwd(), 'database/migrations');

// Advisory lock key dedicated for DropShield migrations (deterministic 64-bit int representation)
export const ADVISORY_LOCK_ID = 748291048;

export interface MigrationRecord {
  version: string;
  filename: string;
  executed_at: Date;
  checksum: string;
}

export function getMigrationClient(customUrl?: string): pg.Client {
  const connectionUrl = customUrl || env.DIRECT_DATABASE_URL || env.DATABASE_URL;
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
 * Ensure the migration tracking table exists
 */
export async function ensureMigrationTable(client: pg.Client): Promise<void> {
  // Create table with checksum column; if table already exists, ALTER will add column safely.
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version VARCHAR(50) PRIMARY KEY,
      filename VARCHAR(255) NOT NULL,
      executed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      checksum VARCHAR(64) NOT NULL
    );
  `);
  // Ensure checksum column exists for older installations (default empty string).
  await client.query(`
    ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum VARCHAR(64) NOT NULL DEFAULT '';
  `);
}
/**
 * Acquire PostgreSQL advisory lock
 */
export async function acquireLock(client: pg.Client): Promise<void> {
  logger.info('Acquiring migration advisory lock...');
  await client.query('SELECT pg_advisory_lock($1);', [ADVISORY_LOCK_ID]);
  logger.info('Advisory lock acquired.');
}

/**
 * Release PostgreSQL advisory lock
 */
export async function releaseLock(client: pg.Client): Promise<void> {
  try {
    await client.query('SELECT pg_advisory_unlock($1);', [ADVISORY_LOCK_ID]);
    logger.info('Advisory lock released.');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('Error releasing advisory lock:', msg);
  }
}

/**
 * Get all applied migrations
 */
export async function getAppliedMigrations(client: pg.Client): Promise<MigrationRecord[]> {
  const colCheck = await client.query(`
    SELECT column_name FROM information_schema.columns 
    WHERE table_name = 'schema_migrations' AND column_name = 'checksum';
  `);
  const hasChecksum = (colCheck.rowCount ?? 0) > 0;
  if (hasChecksum) {
    const res = await client.query<MigrationRecord>(
      'SELECT version, filename, executed_at, checksum FROM schema_migrations ORDER BY version ASC;'
    );
    return res.rows;
  } else {
    const res = await client.query<{ version: string; filename: string; executed_at: Date }>(
      'SELECT version, filename, executed_at FROM schema_migrations ORDER BY version ASC;'
    );
    return res.rows.map((r) => ({ ...r, checksum: '' }));
  }
}

/**
 * Find all migration pairs in database/migrations
 */
export function getMigrationFiles(): { version: string; upFile: string; downFile?: string }[] {
  if (!fs.existsSync(MIGRATIONS_DIR)) {
    return [];
  }

  const files = fs.readdirSync(MIGRATIONS_DIR);
  const upFiles = files.filter((f) => f.endsWith('.up.sql')).sort();

  return upFiles.map((upFile) => {
    const version = upFile.split('_')[0];
    const baseName = upFile.replace('.up.sql', '');
    const downFileCandidate = `${baseName}.down.sql`;
    const downFile = files.includes(downFileCandidate) ? downFileCandidate : undefined;
    return { version, upFile, downFile };
  });
}

/**
 * Run all pending UP migrations
 */
export async function migrateUp(customClient?: pg.Client): Promise<void> {
  const client = customClient || getMigrationClient();
  const shouldCloseClient = !customClient;
  if (shouldCloseClient) {
    await client.connect();
  }

  try {
    await ensureMigrationTable(client);
    await acquireLock(client);

    const applied = await getAppliedMigrations(client);
    const available = getMigrationFiles();
    const availableMap = new Map(available.map((m) => [m.version, m]));

    // Checksum verification of all already applied migrations
    for (const appliedMigration of applied) {
      const fileInfo = availableMap.get(appliedMigration.version);
      if (!fileInfo) {
        throw new Error(`Applied migration ${appliedMigration.version} (${appliedMigration.filename}) not found in migrations directory`);
      }
      const filePath = path.join(MIGRATIONS_DIR, fileInfo.upFile);
      const computed = computeChecksum(filePath);

      if (!appliedMigration.checksum || appliedMigration.checksum === '') {
        // Legacy migration record without checksum
        if (process.env.ALLOW_UNVERIFIED_MIGRATION_CHECKSUM_BASELINE === 'true') {
          logger.warn(`Baseline verification flag enabled: recording checksum baseline for legacy migration ${appliedMigration.version}`);
          await client.query('UPDATE schema_migrations SET checksum = $1 WHERE version = $2', [computed, appliedMigration.version]);
        } else {
          throw new Error(
            `Legacy migration record found without checksum for version ${appliedMigration.version} (${appliedMigration.filename}). ` +
            `Automatic backfill is prohibited without explicit baseline verification. ` +
            `Set ALLOW_UNVERIFIED_MIGRATION_CHECKSUM_BASELINE=true only after manual verification.`
          );
        }
      } else if (appliedMigration.checksum !== computed) {
        throw new Error(
          `Migration checksum mismatch for version ${appliedMigration.version} (${appliedMigration.filename}): ` +
          `recorded '${appliedMigration.checksum}', computed '${computed}'. Migration file has been altered!`
        );
      }
    }

    const appliedVersions = new Set(applied.map((m) => m.version));
    const pending = available.filter((m) => !appliedVersions.has(m.version));

    if (pending.length === 0) {
      logger.info('No pending migrations. Database schema is up to date.');
      return;
    }

    logger.info(`Found ${pending.length} pending migration(s) to apply.`);

    for (const migration of pending) {
      const filePath = path.join(MIGRATIONS_DIR, migration.upFile);
      const sql = fs.readFileSync(filePath, 'utf8');
      const checksum = computeChecksum(filePath);

      logger.info(`Applying migration: ${migration.upFile}...`);
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(
          'INSERT INTO schema_migrations (version, filename, executed_at, checksum) VALUES ($1, $2, CURRENT_TIMESTAMP, $3)',
          [migration.version, migration.upFile, checksum]
        );
        await client.query('COMMIT');
        logger.info(`Successfully applied migration: ${migration.upFile} (checksum: ${checksum.slice(0, 12)}...)`);
      } catch (err: unknown) {
        await client.query('ROLLBACK');
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`Failed to apply migration ${migration.upFile}:`, msg);
        throw err;
      }
    }
  } finally {
    await releaseLock(client);
    if (shouldCloseClient) {
      await client.end();
    }
  }
}

/**
 * Rollback the single most recent migration (explicit user trigger only)
 */
export async function migrateRollback(customClient?: pg.Client): Promise<void> {
  const client = customClient || getMigrationClient();
  const shouldCloseClient = !customClient;
  if (shouldCloseClient) {
    await client.connect();
  }

  try {
    await ensureMigrationTable(client);
    await acquireLock(client);

    const applied = await getAppliedMigrations(client);
    if (applied.length === 0) {
      logger.info('No migrations to rollback.');
      return;
    }

    const latest = applied[applied.length - 1];
    const available = getMigrationFiles();
    const migrationMeta = available.find((m) => m.version === latest.version);

    if (!migrationMeta || !migrationMeta.downFile) {
      throw new Error(`Down migration file not found for version ${latest.version}`);
    }

    const filePath = path.join(MIGRATIONS_DIR, migrationMeta.downFile);
    const sql = fs.readFileSync(filePath, 'utf8');

    logger.info(`Rolling back migration: ${migrationMeta.downFile}...`);
    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query('DELETE FROM schema_migrations WHERE version = $1', [latest.version]);
      await client.query('COMMIT');
      logger.info(`Successfully rolled back migration: ${latest.version} (${migrationMeta.downFile})`);
    } catch (err: unknown) {
      await client.query('ROLLBACK');
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`Failed to rollback migration ${migrationMeta.downFile}:`, msg);
      throw err;
    }
  } finally {
    await releaseLock(client);
    if (shouldCloseClient) {
      await client.end();
    }
  }
}

/**
 * Check and display status of all migrations (strictly read-only)
 */
export async function migrationStatus(customClient?: pg.Client): Promise<void> {
  const client = customClient || getMigrationClient();
  const shouldCloseClient = !customClient;
  if (shouldCloseClient) {
    await client.connect();
  }

  try {
    const tableCheck = await client.query(`
      SELECT 1 FROM information_schema.tables WHERE table_name = 'schema_migrations';
    `);
    let applied: MigrationRecord[] = [];
    if (tableCheck.rowCount && tableCheck.rowCount > 0) {
      applied = await getAppliedMigrations(client);
    }
    const appliedMap = new Map(applied.map((m) => [m.version, m]));
    const available = getMigrationFiles();

    console.log('\n--- DropShield Schema Migration Status ---');
    console.log('Version | Status  | Checksum Integrity | Migration File                 | Applied At');
    console.log('------------------------------------------------------------------------------------------------');

    for (const m of available) {
      const rec = appliedMap.get(m.version);
      const status = rec ? 'APPLIED' : 'PENDING';
      const appliedAt = rec ? rec.executed_at.toISOString() : '-';
      let integrity = 'N/A';
      if (rec) {
        const filePath = path.join(MIGRATIONS_DIR, m.upFile);
        const computed = computeChecksum(filePath);
        if (!rec.checksum) {
          integrity = 'LEGACY_MISSING';
        } else if (rec.checksum === computed) {
          integrity = 'VERIFIED';
        } else {
          integrity = 'MISMATCH';
        }
      }
      console.log(
        `${m.version.padEnd(7)} | ${status.padEnd(7)} | ${integrity.padEnd(18)} | ${m.upFile.padEnd(30)} | ${appliedAt}`
      );
    }
    console.log('------------------------------------------------------------------------------------------------\n');
  } finally {
    if (shouldCloseClient) {
      await client.end();
    }
  }
}

// CLI runner
const command = process.argv[2];

if (command === 'up') {
  migrateUp().catch((err) => {
    console.error('Migration failed:', err.message);
    process.exit(1);
  });
} else if (command === 'down') {
  migrateRollback().catch((err) => {
    console.error('Rollback failed:', err.message);
    process.exit(1);
  });
} else if (command === 'status') {
  migrationStatus().catch((err) => {
    console.error('Status check failed:', err.message);
    process.exit(1);
  });
}
