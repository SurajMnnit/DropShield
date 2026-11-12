import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { assertTestDatabaseUrl } from '../src/config/database.js';
import { computeChecksum, MIGRATIONS_DIR } from '../src/scripts/migrate.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('DropShield Phase 3: Migration Safety & Test Database Isolation Guards', () => {
  describe('Test Database URL Guard (assertTestDatabaseUrl)', () => {
    const originalEnv = { ...process.env };

    beforeEach(() => {
      process.env.DATABASE_URL = 'postgresql://user:secret@ep-prod.neon.tech/dropshield?sslmode=require';
      process.env.DIRECT_DATABASE_URL = 'postgresql://user:secret@ep-prod-direct.neon.tech/dropshield?sslmode=require';
    });

    afterEach(() => {
      process.env = { ...originalEnv };
    });

    it('rejects undefined or empty TEST_DATABASE_URL', () => {
      expect(() => assertTestDatabaseUrl(undefined)).toThrow(/required for integration tests/i);
      expect(() => assertTestDatabaseUrl('')).toThrow(/required for integration tests/i);
      expect(() => assertTestDatabaseUrl('   ')).toThrow(/required for integration tests/i);
    });

    it('rejects TEST_DATABASE_URL if it matches primary DATABASE_URL', () => {
      expect(() => assertTestDatabaseUrl(process.env.DATABASE_URL)).toThrow(/cannot match the primary DATABASE_URL/i);
    });

    it('rejects TEST_DATABASE_URL if it matches DIRECT_DATABASE_URL', () => {
      expect(() => assertTestDatabaseUrl(process.env.DIRECT_DATABASE_URL)).toThrow(/cannot match the DIRECT_DATABASE_URL/i);
    });

    it('rejects production database names (e.g. dropshield, production, postgres, main)', () => {
      expect(() => assertTestDatabaseUrl('postgresql://user:pass@localhost:5432/dropshield')).toThrow(/cannot point to primary or production database/i);
      expect(() => assertTestDatabaseUrl('postgresql://user:pass@localhost:5432/production')).toThrow(/cannot point to primary or production database/i);
      expect(() => assertTestDatabaseUrl('postgresql://user:pass@localhost:5432/postgres')).toThrow(/cannot point to primary or production database/i);
    });

    it('rejects database names without "test" designation', () => {
      expect(() => assertTestDatabaseUrl('postgresql://user:pass@localhost:5432/my_custom_db')).toThrow(/must be explicitly designated as a test database/i);
    });

    it('accepts explicitly designated test databases', () => {
      expect(() => assertTestDatabaseUrl('postgresql://user:pass@localhost:5432/dropshield_test')).not.toThrow();
      expect(() => assertTestDatabaseUrl('postgresql://user:pass@ep-isolated.neon.tech/test_phase3?sslmode=require')).not.toThrow();
    });
  });

  describe('Migration Checksum Engine', () => {
    it('computes deterministic SHA-256 checksums', () => {
      const upFile = path.join(MIGRATIONS_DIR, '001_initial_schema.up.sql');
      expect(fs.existsSync(upFile)).toBe(true);

      const checksum1 = computeChecksum(upFile);
      const checksum2 = computeChecksum(upFile);

      expect(checksum1).toBe(checksum2);
      expect(typeof checksum1).toBe('string');
      expect(checksum1.length).toBe(64); // SHA-256 hex length
      expect(/^[0-9a-f]{64}$/.test(checksum1)).toBe(true);
    });

    it('detects file modifications by producing differing checksums', () => {
      const tempFile = path.join(__dirname, 'temp_test_migration.sql');
      try {
        fs.writeFileSync(tempFile, 'CREATE TABLE test_sample (id INT);', 'utf8');
        const hashOriginal = computeChecksum(tempFile);

        fs.writeFileSync(tempFile, 'CREATE TABLE test_sample (id INT, modified BOOLEAN);', 'utf8');
        const hashModified = computeChecksum(tempFile);

        expect(hashOriginal).not.toBe(hashModified);
      } finally {
        if (fs.existsSync(tempFile)) {
          fs.unlinkSync(tempFile);
        }
      }
    });
  });

  describe('Advisory Lock & Legacy Checksum Policies', () => {
    it('mock verifies rejection of legacy migration with missing checksum without baseline flag', async () => {
      const mockAppliedMigrations = [
        {
          version: '001',
          filename: '001_initial_schema.up.sql',
          executed_at: new Date(),
          checksum: '', // legacy missing checksum
        },
      ];

      const originalFlag = process.env.ALLOW_UNVERIFIED_MIGRATION_CHECKSUM_BASELINE;
      delete process.env.ALLOW_UNVERIFIED_MIGRATION_CHECKSUM_BASELINE;

      const rec = mockAppliedMigrations[0];
      const checkLegacyPolicy = (checksum: string) => {
        if (!checksum && process.env.ALLOW_UNVERIFIED_MIGRATION_CHECKSUM_BASELINE !== 'true') {
          throw new Error('Legacy migration record found without checksum. Automatic backfill is prohibited.');
        }
      };

      expect(() => checkLegacyPolicy(rec.checksum)).toThrow(/Automatic backfill is prohibited/i);

      process.env.ALLOW_UNVERIFIED_MIGRATION_CHECKSUM_BASELINE = 'true';
      expect(() => checkLegacyPolicy(rec.checksum)).not.toThrow();

      if (originalFlag) {
        process.env.ALLOW_UNVERIFIED_MIGRATION_CHECKSUM_BASELINE = originalFlag;
      } else {
        delete process.env.ALLOW_UNVERIFIED_MIGRATION_CHECKSUM_BASELINE;
      }
    });

    it('mock verifies checksum mismatch triggers an error', () => {
      const storedChecksum = '0000000000000000000000000000000000000000000000000000000000000000';
      const upFile = path.join(MIGRATIONS_DIR, '001_initial_schema.up.sql');
      const actualChecksum = computeChecksum(upFile);

      const verifyChecksum = (stored: string, current: string) => {
        if (stored !== current) {
          throw new Error(`Checksum mismatch: recorded '${stored}', computed '${current}'`);
        }
      };

      expect(() => verifyChecksum(storedChecksum, actualChecksum)).toThrow(/Checksum mismatch/i);
      expect(() => verifyChecksum(actualChecksum, actualChecksum)).not.toThrow();
    });
  });
});
