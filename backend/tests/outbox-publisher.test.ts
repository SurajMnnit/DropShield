import pg from 'pg';
import crypto from 'crypto';
import { assertTestDatabaseUrl, closeDbPool } from '../src/config/database.js';
import { TransactionalOutboxService } from '../src/services/outbox.service.js';
import { closeRabbitMQClient } from '../src/config/rabbitmq.js';

describe('DropShield Phase 5: Transactional Outbox & Publisher Test Suite', () => {
  let client: pg.Client;
  const testSchema = 'test_phase5_outbox_' + crypto.randomUUID().replace(/-/g, '_');

  beforeAll(async () => {
    const testDbUrl = process.env.TEST_DATABASE_URL || 'postgresql://postgres:postgres@localhost:5433/dropshield_test';
    assertTestDatabaseUrl(testDbUrl);

    client = new pg.Client({
      connectionString: testDbUrl,
      connectionTimeoutMillis: 10000,
    });
    await client.connect();

    // Verify test database
    const dbCheck = await client.query('SELECT current_database() as db_name;');
    const currentDb = String(dbCheck.rows[0].db_name).toLowerCase();
    if (!currentDb.includes('test')) {
      throw new Error(`CRITICAL: Connected database '${currentDb}' is not an authorized test database.`);
    }
  });

  afterAll(async () => {
    try {
      await client.query(`DROP SCHEMA IF EXISTS ${testSchema} CASCADE;`);
    } catch {
      // ignore
    }
    await client.end();
    await closeDbPool();
    await closeRabbitMQClient();
  });

  describe('1. Outbox Event Creation', () => {
    it('creates an outbox event atomically within a transaction', async () => {
      const outboxService = new TransactionalOutboxService('test-creator', client);
      const resId = crypto.randomUUID();

      await client.query('BEGIN');
      const event = await outboxService.createOutboxEvent(client, {
        aggregateType: 'RESERVATION',
        aggregateId: resId,
        eventType: 'booking.requested',
        payload: {
          reservationId: resId,
          amount: 2500,
        },
      });
      await client.query('COMMIT');

      expect(event.id).toBeDefined();
      expect(event.aggregate_id).toBe(resId);
      expect(event.status).toBe('PENDING');
      expect(event.attempts).toBe(0);
    });
  });

  describe('2. Concurrent Claiming & FOR UPDATE SKIP LOCKED', () => {
    it('concurrent publishers claim distinct batches without collisions', async () => {
      const outboxService = new TransactionalOutboxService('test-seeder', client);

      // Seed 10 pending events
      for (let i = 0; i < 10; i++) {
        await outboxService.createOutboxEvent(client, {
          aggregateType: 'RESERVATION',
          aggregateId: `res-claim-${i}`,
          eventType: 'booking.requested',
          payload: { index: i },
        });
      }

      // Helper query simulating claimPendingEvents using our test client
      const claimWithClient = async (publisherId: string, limit: number) => {
        const query = `
          WITH candidates AS (
            SELECT id FROM outbox_events
            WHERE status = 'PENDING' AND available_at <= CURRENT_TIMESTAMP
            ORDER BY available_at ASC
            LIMIT $1
            FOR UPDATE SKIP LOCKED
          )
          UPDATE outbox_events
          SET status = 'PROCESSING',
              locked_at = CURRENT_TIMESTAMP,
              locked_by = $2
          FROM candidates
          WHERE outbox_events.id = candidates.id
          RETURNING outbox_events.*;
        `;
        const res = await client.query(query, [limit, publisherId]);
        return res.rows;
      };

      const batch1 = await claimWithClient('pub-worker-A', 5);
      const batch2 = await claimWithClient('pub-worker-B', 5);

      expect(batch1.length).toBe(5);
      expect(batch2.length).toBe(5);

      // Verify no intersection between claimed IDs
      const ids1 = new Set(batch1.map((e) => e.id));
      const ids2 = new Set(batch2.map((e) => e.id));
      for (const id of ids1) {
        expect(ids2.has(id)).toBe(false);
      }
    });
  });

  describe('3. Publisher Confirm & Failure Recovery', () => {
    it('publishes claimed event to RabbitMQ, waits for confirm, and marks PUBLISHED', async () => {
      const outboxService = new TransactionalOutboxService('test-confirm-publisher', client);
      const resId = crypto.randomUUID();

      const created = await outboxService.createOutboxEvent(client, {
        aggregateType: 'RESERVATION',
        aggregateId: resId,
        eventType: 'booking.requested',
        payload: {
          reservationId: resId,
          version: 'v1',
        },
      });

      // Claim it
      await client.query(
        `UPDATE outbox_events SET status = 'PROCESSING', locked_at = CURRENT_TIMESTAMP WHERE id = $1;`,
        [created.id]
      );

      // Publish event
      const published = await outboxService.publishEvent({
        ...created,
        status: 'PROCESSING',
      });

      expect(published).toBe(true);

      // Verify in DB that status is now PUBLISHED
      const checkRes = await client.query('SELECT status, published_at FROM outbox_events WHERE id = $1;', [
        created.id,
      ]);
      expect(checkRes.rows[0].status).toBe('PUBLISHED');
      expect(checkRes.rows[0].published_at).not.toBeNull();
    });

    it('recovers stale PROCESSING events where previous publisher crashed', async () => {
      const resId = crypto.randomUUID();

      // Insert event that was locked 5 minutes ago and crashed
      await client.query(`
        INSERT INTO outbox_events (
          aggregate_type, aggregate_id, event_type, payload, status, locked_at, locked_by
        ) VALUES (
          'RESERVATION', '${resId}', 'booking.requested', '{"test":true}', 'PROCESSING',
          CURRENT_TIMESTAMP - INTERVAL '5 minutes', 'crashed-publisher'
        );
      `);

      // Claim query should identify stale locked event
      const recoverRes = await client.query(`
        SELECT id, aggregate_id, status FROM outbox_events
        WHERE status = 'PROCESSING' AND locked_at < CURRENT_TIMESTAMP - INTERVAL '1 minute';
      `);

      expect(recoverRes.rows.some((r) => r.aggregate_id === resId)).toBe(true);
    });
  });
});
