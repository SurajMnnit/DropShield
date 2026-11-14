# DropShield Reliability, Recovery & Failure Architecture

This document describes the reliability, recovery, and self-healing architecture implemented in **Phase 7** of the DropShield distributed ticketing engine.

---

## 1. Core Principles

1. **PostgreSQL is the Absolute Source of Truth:**
   - Redis serves as the high-throughput, low-latency coordination layer for fast holding and concurrency arbitration.
   - Any divergence between Redis in-memory cache and PostgreSQL is always resolved in favor of PostgreSQL.
   - Redis never overwrites confirmed bookings in PostgreSQL.

2. **Distributed Single-Leader Reconciliation:**
   - Reconciliation sweeps acquire a PostgreSQL transactional advisory lock (`pg_try_advisory_xact_lock(740001)`).
   - Only one reconciliation worker runs cluster-wide at any given moment.
   - Locks release automatically upon transaction commit or rollback, preventing deadlocks or abandoned lock state.

3. **At-Least-Once Delivery with Idempotent Consumers:**
   - Outbox events and RabbitMQ messages are acknowledged only after database state commits.
   - Message consumers verify reservation states and check for existing bookings before taking action, guaranteeing safe deduplication under redelivery.

---

## 2. Multi-System Reconciliation Engine

The `ReconciliationService` (`backend/src/services/reconciliation.service.ts`) periodically scans across PostgreSQL, Redis, and RabbitMQ to identify and repair inconsistencies:

| Inconsistency Type | Cause | Resolution Strategy |
| :--- | :--- | :--- |
| `EXPIRED_RESERVATION_STUCK` | Crash during reservation expiry sweep or delayed worker execution | Transitions reservation to `EXPIRED` in PostgreSQL and resets held seats to `AVAILABLE` in both PostgreSQL and Redis. |
| `STUCK_OUTBOX_EVENT` | Outbox publisher process crashed while holding event lock | Releases lock (`locked_at = NULL, locked_by = NULL`) and resets status to `PENDING` for redelivery. |
| `PAYMENT_BOOKING_DISAGREEMENT` | Transaction interrupted between payment recording and booking finalization | Atomically validates booking linkage or marks payment failed. |
| `MISSING_LEDGER_RECORD` | Failure during ledger insertion or uncommitted audit trail | Appends immutable `CHARGE` entry to `transaction_ledger` with verifiable hash reference. |
| `POSTGRES_BOOKED_MISSING_REDIS` | Redis cache flushed, crashed, or missing updated key | Repopulates Redis seat hash to `BOOKED` directly from PostgreSQL source of truth. |
| `REDIS_ORPHAN_BOOKED` | Redis seat marked `BOOKED` without corresponding booking in PostgreSQL | Restores Redis seat status to `AVAILABLE`. |

---

## 3. Dead-Letter Queue (DLQ) & Safe Replay

The `DeadLetterService` (`backend/src/services/dlq.service.ts`) manages poison-pill isolation and message recovery:

- **Non-Destructive Inspection (`inspectDeadLetterQueue`):** Samples messages via `basic.get` with immediate requeuing (`nack(requeue=true)`), producing inspection reports without modifying message order.
- **Idempotent Replay (`replayDeadLetterMessages`):**
  - Validates reservation status in PostgreSQL prior to replay.
  - If already `CONFIRMED` or `EXPIRED`, discards the message from DLQ without re-dispatching.
  - If eligible, re-publishes to `dropshield.booking` exchange with `x-replay-count` header (bounded at max 3 replays).

---

## 4. Redis Failure Recovery

- **Inventory Reconstitution (`reconstructSessionInventory`):**
  - Reconstructs session seats, active pending reservations, and expiration sorted sets from PostgreSQL in a single pipeline after total cache loss.
- **Stale Expiry Protection:**
  - Lua scripts enforce lease timestamp and state validations. Stale expiry sweeps cannot release seats that transitioned to `BOOKED` or were re-held by a new reservation.
- **Exponential Backoff & Jitter:**
  - Redis commands implement bounded exponential backoff with randomized jitter to mitigate thundering herds upon recovery.

---

## 5. Controlled Failure Injection Framework

The `FailureInjector` (`backend/src/testing/failure-injector.ts`) provides deterministic simulation of infrastructure failure modes:

- Strictly gated to `NODE_ENV === 'test'` and strictly rejected in `production`.
- Supports 11 failure points:
  - `REDIS_HOLD_FAILURE`
  - `REDIS_CONFIRM_FAILURE`
  - `REDIS_RELEASE_FAILURE`
  - `DATABASE_QUERY_ABORT`
  - `DATABASE_COMMIT_ABORT`
  - `RABBITMQ_PUBLISH_FAIL`
  - `PAYMENT_PROVIDER_TIMEOUT`
  - `PAYMENT_AMBIGUOUS_RESULT`
  - `OUTBOX_PUBLISHER_CRASH`
  - `WORKER_CRASH_BEFORE_ACK`
  - `EXPIRY_WORKER_INTERRUPTED`

---

## 6. Operational CLI Script

Administrators and SRE teams can execute reconciliation tasks manually via:

```bash
# Display system health, outbox lag, and DLQ depth
npm run reconcile

# Execute reconciliation dry run (zero mutations)
npm run reconcile:dry-run

# Execute reconciliation repair
npm run reconcile repair

# Inspect DLQ messages
npm run reconcile dlq-inspect

# Safely replay eligible DLQ messages
npm run reconcile dlq-replay

# Rebuild Redis session inventory from PostgreSQL
npm run reconcile reconstruct-inventory <sessionId>
```
