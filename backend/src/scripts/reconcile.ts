#!/usr/bin/env node
import { dbPool } from '../config/database.js';
import { closeRedisClient } from '../config/redis.js';
import { closeRabbitMQClient } from '../config/rabbitmq.js';
import { ReconciliationService } from '../services/reconciliation.service.js';
import { DeadLetterService } from '../services/dlq.service.js';
import { RedisInventoryService } from '../services/inventory.service.js';
import { logger } from '../utils/logger.js';

async function printHeader(title: string): Promise<void> {
  console.log('\n======================================================');
  console.log(` DropShield Operations CLI — ${title}`);
  console.log('======================================================\n');
}

async function showStatus(): Promise<void> {
  await printHeader('System Health & Reconciliation Status');

  // 1. PostgreSQL Outbox lag
  const outboxRes = await dbPool.query<{ count: string; oldest_pending: Date | null }>(
    `SELECT COUNT(*) as count, MIN(created_at) as oldest_pending
     FROM outbox_events
     WHERE status = 'PENDING';`
  );

  // 2. Dead-letter queue depth
  const dlqService = new DeadLetterService();
  const dlqInfo = await dlqService.inspectDeadLetterQueue(1).catch(() => ({ totalMessages: -1 }));

  // 3. PostgreSQL Pending vs Expired Reservations
  const resStats = await dbPool.query<{ status: string; count: string }>(
    `SELECT status, COUNT(*) as count FROM reservations GROUP BY status;`
  );

  console.log('--- Outbox Status ---');
  console.log(`Pending Outbox Events: ${outboxRes.rows[0]?.count || 0}`);
  console.log(`Oldest Pending Event: ${outboxRes.rows[0]?.oldest_pending || 'None'}`);

  console.log('\n--- RabbitMQ DLQ Status ---');
  console.log(`Dead-Letter Queue Depth: ${dlqInfo.totalMessages >= 0 ? dlqInfo.totalMessages : 'Unreachable'}`);

  console.log('\n--- Reservation Statuses ---');
  for (const r of resStats.rows) {
    console.log(`  ${r.status}: ${r.count}`);
  }
}

async function runReconcile(dryRun: boolean): Promise<void> {
  await printHeader(`Running Reconciliation (dryRun: ${dryRun})`);
  const service = new ReconciliationService();
  const report = await service.runReconciliation({ dryRun });

  console.log(`Reconciliation ID: ${report.reconciliationId}`);
  console.log(`Duration: ${report.durationMs}ms`);
  console.log(`Total Inconsistencies Detected: ${report.totalDetected}`);
  console.log(`Total Repaired: ${report.totalRepaired}`);
  console.log(`Total Unresolved: ${report.totalFailed}`);

  if (report.discrepancies.length > 0) {
    console.log('\nDiscrepancies:');
    console.table(
      report.discrepancies.map((d) => ({
        Type: d.type,
        Entity: d.entityId.slice(0, 18),
        Session: d.sessionId?.slice(0, 8) || 'N/A',
        Repaired: d.repaired,
        Action: d.repairAction || d.error || 'N/A',
      }))
    );
  } else {
    console.log('\nAll checked systems are in 100% sync.');
  }
}

async function inspectDLQ(): Promise<void> {
  await printHeader('DLQ Inspection');
  const dlqService = new DeadLetterService();
  const report = await dlqService.inspectDeadLetterQueue(50);

  console.log(`Queue: ${report.queue}`);
  console.log(`Total DLQ Messages: ${report.totalMessages}`);
  console.log(`Sampled: ${report.inspectedCount}`);

  if (report.items.length > 0) {
    console.table(
      report.items.map((i) => ({
        ReservationId: i.reservationId || 'N/A',
        EventType: i.eventType || 'N/A',
        DeathReason: i.deathReason || 'N/A',
        DeathCount: i.deathCount || 1,
        EligibleForReplay: i.eligibleForReplay,
        DBStatus: i.reservationStatus || 'N/A',
      }))
    );
  }
}

async function replayDLQ(): Promise<void> {
  await printHeader('DLQ Safe Replay');
  const dlqService = new DeadLetterService();
  const report = await dlqService.replayDeadLetterMessages(50);

  console.log(`Total Processed: ${report.totalProcessed}`);
  console.log(`Replayed to Active Queue: ${report.replayedCount}`);
  console.log(`Discarded Duplicates: ${report.discardedDuplicatesCount}`);
  console.log(`Discarded Expired: ${report.discardedExpiredCount}`);
  console.log(`Failed: ${report.failedCount}`);
}

async function reconstructInventory(sessionId: string): Promise<void> {
  if (!sessionId) {
    console.error('Error: sessionId argument is required. Usage: reconcile reconstruct-inventory <sessionId>');
    process.exit(1);
  }
  await printHeader(`Reconstructing Redis Inventory for Session ${sessionId}`);
  const inventoryService = new RedisInventoryService();
  const result = await inventoryService.reconstructSessionInventory(sessionId);

  console.log(`Reconstruction Complete:`);
  console.log(`  Seats Restored in Redis: ${result.restoredSeats}`);
  console.log(`  Active Reservations Restored: ${result.restoredReservations}`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0] || 'status';

  try {
    switch (command) {
      case 'status':
        await showStatus();
        break;
      case 'dry-run':
        await runReconcile(true);
        break;
      case 'repair':
        await runReconcile(false);
        break;
      case 'dlq-inspect':
        await inspectDLQ();
        break;
      case 'dlq-replay':
        await replayDLQ();
        break;
      case 'reconstruct-inventory':
        await reconstructInventory(args[1]);
        break;
      default:
        console.log(`Unknown command: ${command}`);
        console.log('Available commands: status, dry-run, repair, dlq-inspect, dlq-replay, reconstruct-inventory <sessionId>');
        break;
    }
  } catch (err) {
    logger.error('Error during reconciliation CLI execution:', err);
    process.exit(1);
  } finally {
    await dbPool.end().catch(() => {});
    await closeRedisClient().catch(() => {});
    await closeRabbitMQClient().catch(() => {});
    process.exit(0);
  }
}

main();
