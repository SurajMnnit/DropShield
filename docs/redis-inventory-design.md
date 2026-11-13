# DropShield Phase 4: Redis Atomic Inventory Engine

## 1. Executive Summary & Design Goals

DropShield is a high-concurrency event ticketing platform engineered to handle extreme traffic spikes (e.g., stadium concert drop events) without overselling, deadlocking, or data corruption.

Phase 4 introduces the **Redis Atomic Inventory Engine**, a sub-millisecond in-memory allocation layer that serves as the first line of defense before persistent database mutations.

### Primary Engineering Objectives:
1. **Zero Overselling Guarantee**: Strict all-or-nothing atomic seat allocation executed via server-side Lua scripts.
2. **Deterministic State Transitions**: Linear seat lifecycle: `AVAILABLE` -> `HELD` -> `BOOKED` (with bidirectional transition back to `AVAILABLE` upon release or expiration).
3. **Cluster Scalability**: Redis Cluster compatibility enforced via `{sessionId}` hash tags ensuring single-slot co-location of all session data without cross-slot evaluation errors.
4. **Resilient Expiry & Reclamation**: High-durability Sorted Set (`ZSET`) indexing for reservation leases, immune to Redis keyspace notification drops or worker crashes.
5. **Exact Idempotency**: Cryptographic SHA-256 payload fingerprinting and cached response replay to protect against network retries and duplicate user submissions.
6. **Dual-Database Consistency**: Clear architectural boundary between Redis (hot-path ephemeral allocation) and PostgreSQL (durable system of record and financial ledger).

---

## 2. Architecture & Redis Topology

```
               [ High-Concurrency Ingress ]
                            │
               ┌────────────▼────────────┐
               │    DropShield Backend   │
               │  (Inventory Service)    │
               └────────────┬────────────┘
                            │
              ┌─────────────┴─────────────┐
              │                           │
  [ Hot Path: Atomic Allocation ]  [ Background Workers ]
              │                           │
     ┌────────▼────────┐         ┌────────▼────────┐
     │  Redis Cluster  │         │   Lease Sweeper │
     │  (RAM / Lua)    │         │  (ZSET Recovery)│
     └────────┬────────┘         └────────┬────────┘
              │                           │
              └─────────────┬─────────────┘
                            │ (On Payment / Finalize)
               ┌────────────▼────────────┐
               │  PostgreSQL Persistence │
               │  (ACID Ledger / Audit)  │
               └─────────────────────────┘
```

### Connection Management & Resilience
- **Library**: `ioredis` (v5.6+)
- **Connection Pattern**: Managed singleton with lazy connection and health probe capabilities.
- **Exponential Backoff**:
  ```ts
  retryStrategy: (times: number) => {
    const delay = Math.min(times * 100, 3000);
    return delay;
  }
  ```
- **Connection & Command Timeouts**:
  - `connectTimeout`: 5,000 ms
  - `commandTimeout`: 3,000 ms
- **Health Probing**: `checkRedisHealth()` executes `PING` and records round-trip latency in milliseconds, returning typed status (`up` / `down`) without leaking database credentials.
- **Sanitized Logging**: All connection and command errors are scrubbed to prevent logging passwords, auth tokens, or network URIs.

---

## 3. Redis Cluster Key Architecture & Hash Tagging

Redis Cluster partitions the 16,384 keyspace slots across multiple master nodes. Multi-key operations (such as Lua scripts accessing seat hashes, reservation metadata, expiry indices, and idempotency keys) fail with a `CROSSSLOT Keys in request don't hash to the same slot` error if the keys reside on different nodes.

To guarantee single-slot co-location and 100% Redis Cluster compatibility, all DropShield keys wrap the `sessionId` in curly braces `{sessionId}`:

| Key Format | Redis Type | Description & Value Schema | TTL Policy |
| :--- | :--- | :--- | :--- |
| `dropshield:{sessionId}:seats` | `HASH` | Field: `seatId`<br>Value: `'AVAILABLE'` \| `'HELD'` \| `'BOOKED'` | Persistent per session |
| `dropshield:{sessionId}:reservations:{resId}` | `HASH` | Fields: `userId`, `seats` (comma-separated), `status`, `expiresAt` (Unix ms) | `holdTtlSeconds + 60s` |
| `dropshield:{sessionId}:reservation_seats:{resId}` | `SET` | Members: `seatId` strings belonging to the reservation | `holdTtlSeconds + 60s` |
| `dropshield:{sessionId}:reservation_expirations` | `ZSET` | Member: `resId`<br>Score: `expiresAt` (Unix epoch millisecond timestamp) | Persistent per session index |
| `dropshield:{sessionId}:idempotency:{key}` | `STRING` | Value: JSON string with `status`, `response`, `payloadHash` | Configurable (e.g., 3,600s) |

Because `{sessionId}` is the hash tag, Redis calculates CRC16 only on the string inside the curly braces. Consequently, all keys for session `sess-123` are guaranteed to map to the exact same hash slot across any Redis Cluster topology.

---

## 4. Atomic Lua Scripts

All state transitions are executed via pre-compiled server-side Lua scripts loaded with `EVALSHA` (with automatic fallback to `EVAL` upon `NOSCRIPT` cache misses).

### 4.1. `hold_seats.lua` (Atomic All-or-Nothing Hold)
**Purpose**: Atomically inspect and hold a batch of seats for a specified TTL.
- **Keys**:
  1. `dropshield:{sessionId}:seats`
  2. `dropshield:{sessionId}:reservations:{resId}`
  3. `dropshield:{sessionId}:reservation_seats:{resId}`
  4. `dropshield:{sessionId}:reservation_expirations`
  5. `dropshield:{sessionId}:idempotency:{key}`
- **Execution Lifecycle**:
  1. **Idempotency Pre-Check**: Checks if idempotency key exists.
     - If matching payload hash: Replays cached response immediately.
     - If mismatching payload hash: Aborts with `IDEMPOTENCY_CONFLICT`.
  2. **Duplicate In-Request Check**: Validates that the requested seat array has no duplicates.
  3. **Pre-flight Availability Loop**: Checks each seat in `dropshield:{sessionId}:seats`:
     - If seat does not exist: Aborts with `SEAT_NOT_FOUND` (no mutation).
     - If seat is `HELD` or `BOOKED`: Aborts with `SEAT_UNAVAILABLE` (no mutation).
  4. **Atomic State Mutation**:
     - Updates each seat in `dropshield:{sessionId}:seats` to `HELD`.
     - Populates reservation hash (`userId`, `seats`, `status: 'HELD'`, `expiresAt`).
     - Populates reservation seats set (`SADD`).
     - Adds reservation to Sorted Set index (`ZADD` with score `expiresAt`).
     - Sets TTL buffers on reservation keys.
     - Caches successful response in the idempotency key.
  5. **Result**: Returns `{ success: true, reservationId, heldSeats, expiresAt }`.

### 4.2. `release_seats.lua` (Safe Conditional Release)
**Purpose**: Releases held seats back to `AVAILABLE` upon user cancellation or lease expiration.
- **Safety Boundaries**:
  - Verifies reservation exists and checks user ownership if `expectedUserId` is provided (rejects unauthorized release).
  - Inspects each seat in the reservation: **only changes seat from `HELD` to `AVAILABLE`**.
  - **Never modifies `BOOKED` seats**: If a seat has already transitioned to `BOOKED`, it is left untouched.
  - Deletes reservation metadata and removes reservation from the expiration `ZSET`.
- **Result**: Returns `{ success: true, releasedCount, reservationId }`.

### 4.3. `confirm_seats.lua` (Atomic Booking Confirmation)
**Purpose**: Transitions seats from `HELD` to `BOOKED` when checkout/payment succeeds.
- **Safety Boundaries**:
  - Verifies idempotency (if already confirmed, returns `ALREADY_CONFIRMED`).
  - Verifies reservation exists and is currently in `HELD` state.
  - Verifies caller `userId` matches the reservation owner.
  - Verifies expiration: If `nowMs > expiresAt`, rejects with `RESERVATION_EXPIRED`.
  - Atomically marks all associated seats in `dropshield:{sessionId}:seats` as `BOOKED`.
  - Updates reservation status to `BOOKED`.
  - Removes the reservation from `dropshield:{sessionId}:reservation_expirations`.
- **Result**: Returns `{ success: true, confirmedSeats, status: 'SUCCESS' }`.

---

## 5. Durable Expiry Engine & Worker Recovery

### Why Redis `EXPIRE` Keyspace Notifications are Insufficient
Many distributed systems rely on Redis keyspace notifications (`notify-keyspace-events Ex`) to trigger expiration callbacks. This approach is unsafe for inventory control because:
1. Keyspace events are **fire-and-forget** Pub/Sub messages. If a network blip occurs or the subscriber is restarting, the notification is permanently lost.
2. Redis only emits expiration notifications when a key is accessed or evicted by the internal passive/active TTL sampling loop. Eviction timing is non-deterministic and can lag significantly under memory pressure.

### The Sorted Set Index Solution
DropShield indexes every active reservation in a session-scoped Sorted Set:
```
dropshield:{sessionId}:reservation_expirations
  Score:  Unix epoch millisecond timestamp (e.g., 1763048500000)
  Member: reservationId (UUID)
```

### Background Sweeper (`ReservationExpiryService`)
- Sweeps expired reservations using atomic range queries:
  ```
  ZRANGEBYSCORE dropshield:{sessionId}:reservation_expirations 0 {currentEpochMs} LIMIT 0 {batchSize}
  ```
- For each expired reservation, calls `releaseSeats()` with `reason: 'EXPIRED'`.
- Seats are conditionally returned from `HELD` to `AVAILABLE`.

### Worker Crash Recovery
Because expiration state is durably indexed inside Redis itself rather than in-memory worker timers:
- If an application worker crashes during an active hold, no timer is lost.
- When any worker recovers or the next cron sweep executes, it reads `dropshield:{sessionId}:reservation_expirations`, identifies the expired timestamps, and cleanly recovers all orphaned seats.
- Validated by automated failure test suite (`tests/redis-failure.test.ts`).

---

## 6. PostgreSQL Consistency Boundaries & Split-Brain Compensation

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           HYBRID SYSTEM PATTERN                         │
│                                                                         │
│   Fast Ingress / Ephemeral Allocation       Durable Persistence / ACID  │
│   ┌─────────────────────────────────┐       ┌────────────────────────┐  │
│   │          REDIS ENGINE           │       │   POSTGRESQL ENGINE    │  │
│   │                                 │       │                        │  │
│   │ • Sub-millisecond atomic hold   │       │ • Permanent bookings   │  │
│   │ • In-memory seat hash           │       │ • Immutable ledger     │  │
│   │ • Concurrency contention shield │       │ • Financial audit log  │  │
│   │ • Auto-expiring leases          │       │ • Relational integrity │  │
│   └────────────────┬────────────────┘       └────────▲───────────────┘  │
│                    │                                 │                  │
│                    │     [ Checkout & Payment ]      │                  │
│                    └─────────────────────────────────┘                  │
└─────────────────────────────────────────────────────────────────────────┘
```

### Complete Transaction Lifecycle:
1. **Seat Selection**: User selects seats.
2. **Atomic Hold (Redis)**: `holdSeats()` reserves seats in Redis with a 10-minute hold TTL (`HELD`).
3. **Payment Processing**: User submits payment details during the 10-minute lease window.
4. **PostgreSQL Persistence**:
   - Begins PostgreSQL transaction.
   - Verifies session and seat inventory constraints.
   - Inserts booking row, reservation row, and ledger transaction entry (`BIGINT` minor units).
   - Commits PostgreSQL transaction.
5. **Atomic Confirmation (Redis)**: `confirmSeats()` updates Redis seat status to `BOOKED` and removes the expiry index.

### Failure Compensation Strategies:
- **Payment Failed or Cancelled**: Compensation worker calls `releaseSeats()` in Redis; inventory immediately becomes `AVAILABLE` for other users.
- **Database Write Failure**: If the PostgreSQL transaction fails or times out, the Redis hold is released via compensation rollback.
- **Cold Boot / Redis Data Loss**: If a catastrophic Redis failure occurs, Redis inventory is rebuilt directly from PostgreSQL by querying active reservations and confirmed bookings (`session_seats` status).

---

## 7. Automated Test Suite & Validation Matrix

The engine is validated with 22 automated integration tests running against native Redis:

| Test Group | Test Case Description | Verified Behavior |
| :--- | :--- | :--- |
| **Health** | Redis connection & ping probe | Accurately returns latency (`latencyMs`) and `up` status |
| **Atomicity** | Hold multiple available seats | All seats transition to `HELD`; metadata & expiry indexed |
| **Validation** | Duplicate seats in single request | Entire request rejected with `DUPLICATE_SEAT_IN_REQUEST`; zero state changes |
| **Validation** | Non-existent seat in hold request | Rejected with `SEAT_NOT_FOUND`; zero state changes |
| **Contention** | Overlapping seat requests | Rejected with `SEAT_UNAVAILABLE`; remaining seats not partially allocated |
| **Concurrency** | Concurrent race condition (2 callers, same seat) | Exactly one caller wins (`success: true`); loser receives `SEAT_UNAVAILABLE` |
| **Concurrency** | High-contention race (10 concurrent holds for 1 seat) | Exactly 1 winner, exactly 9 clean rejections; no race corruption |
| **Idempotency** | Exact replay of identical hold request | Returns original reservation details with `replayed: true` |
| **Idempotency** | Conflict with altered payload | Rejects with `IDEMPOTENCY_CONFLICT` |
| **Release** | Safe cancellation of held seat | Seats transition back to `AVAILABLE`; metadata removed |
| **Release** | Release idempotency & non-existent reservation | Safely returns `releasedCount: 0` without crashing |
| **Security** | Cross-user release attempt | Fails with `UNAUTHORIZED_RELEASE`; seat remains held |
| **Confirmation** | Confirm active held seats | Seats atomically transition to `BOOKED` |
| **Confirmation** | Idempotent repeat confirmation | Returns `ALREADY_CONFIRMED` without error |
| **Confirmation** | Expired reservation confirmation | Rejects with `RESERVATION_EXPIRED` |
| **Expiry** | Background sweep of expired holds | Expired holds identified and automatically reclaimed to `AVAILABLE` |
| **Failure** | Input pre-checks (empty seats, invalid TTL) | Rejects before invoking Redis Lua script |
| **Failure** | Worker crash recovery simulation | New worker sweep recovers orphaned holds cleanly after process restart |
| **Resilience** | Disconnected client health check | Accurately returns `down` status with error details |

---

## 8. Operational Metrics & Observability

An in-memory metrics registry (`backend/src/utils/metrics.ts`) provides real-time telemetry:
- **Timers**: `hold_duration_ms`, `release_duration_ms`, `confirm_duration_ms`.
  - Records count, total, average, and peak duration for every Lua operation.
- **Counters**:
  - `hold_success` vs `hold_conflict` / `hold_unavailable`.
  - `release_success` vs `release_expired`.
  - `confirm_success` vs `confirm_expired`.

These metrics provide immediate visibility into lock contention rates, checkout drop-offs, and allocation latency during drop events.
