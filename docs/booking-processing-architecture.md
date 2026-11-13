# DropShield Phase 5: Asynchronous Booking Processing Engine

## 1. Executive Summary & Processing Architecture

DropShield Phase 5 implements a high-throughput, fault-tolerant **Asynchronous Booking Processing Engine**. High-concurrency ticket drops (e.g., stadium concert releases) require low-latency intake at the edge, zero overselling, and decoupled background persistence to protect relational databases from connection exhaustion and write saturation.

### Complete Asynchronous Lifecycle:
```
[ Client Request ]
       │  POST /api/v1/sessions/:sessionId/reservations (X-Idempotency-Key)
       ▼
┌────────────────────────────────────────────────────────────────────────┐
│ Express API Gateway                                                    │
│ 1. Validate payload, seat UUIDs, and caller identity                   │
│ 2. Check DB idempotency record (IN_PROGRESS vs COMPLETED replay)       │
│ 3. Execute atomic Redis hold (hold_seats.lua)                          │
│    └─ If unavailable: 409 Conflict                                     │
│ 4. PostgreSQL Transaction:                                             │
│    • Insert reservation (status: 'PENDING')                            │
│    • Insert reservation_items                                          │
│    • Update session_seats (status: 'HELD')                             │
│    • Insert outbox_events (status: 'PENDING')                          │
│    • Commit transaction                                                │
│    └─ On failure: Rollback + Redis compensation release                │
│ 5. Return HTTP 202 Accepted (reservationId, statusUrl)                │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                         [ Transactional Outbox ]
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ Outbox Relay Publisher                                                 │
│ • Polls outbox_events with FOR UPDATE SKIP LOCKED                      │
│ • Publishes persistent message to RabbitMQ                             │
│ • Waits for broker ConfirmChannel confirmation                         │
│ • Marks outbox event PUBLISHED                                         │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                     [ RabbitMQ Message Broker ]
                     Exchange: dropshield.booking (topic)
                     Queue: dropshield.booking.requested
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ Background Booking Worker Runtime                                      │
│ • Consumes message (bounded prefetch: 10)                              │
│ • Validates message format and event version (v1)                      │
│ • Verifies lease expiration (if expired: reclaim to AVAILABLE)         │
│ • Idempotency check: ignores duplicate deliveries                      │
│ • PostgreSQL Transaction: verifies seat integrity, audit timestamp     │
│ • Acknowledges RabbitMQ message ONLY AFTER DB commit                   │
│ • On transient error: routes to progressive delay retry queues (2s/5s) │
│ • On max retries / corrupt: routes to DLQ (dropshield.booking.dead)   │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 2. RabbitMQ Exchange & Queue Topology

All topology components are declared idempotently on initialization (`assertBookingTopology`):

| Component Type | Name / Key | Type / Mode | Settings & Dead-Letter Routing |
| :--- | :--- | :--- | :--- |
| **Main Exchange** | `dropshield.booking` | `topic` | `durable: true` |
| **Main Queue** | `dropshield.booking.requested` | `quorum / classic` | `durable: true`, DLX: `dropshield.booking.dlx`, DLK: `booking.dead` |
| **Main Routing Key** | `booking.requested` | Routing pattern | Routes intake messages to `dropshield.booking.requested` |
| **Dead-Letter Exchange** | `dropshield.booking.dlx` | `direct` | `durable: true` |
| **Dead-Letter Queue** | `dropshield.booking.dead` | Persistent storage | `durable: true`, unroutable / poison pill storage |
| **Dead Routing Key** | `booking.dead` | Routing pattern | Bound from DLX to DLQ |
| **Retry Exchange** | `dropshield.booking.retry` | `direct` | `durable: true` |
| **Retry Queue 1** | `dropshield.booking.retry.1` | Delay queue | `durable: true`, `messageTtl: 2000ms`, DLX: `dropshield.booking`, DLK: `booking.requested` |
| **Retry Queue 2** | `dropshield.booking.retry.2` | Delay queue | `durable: true`, `messageTtl: 5000ms`, DLX: `dropshield.booking`, DLK: `booking.requested` |
| **Retry Queue 3** | `dropshield.booking.retry.3` | Delay queue | `durable: true`, `messageTtl: 10000ms`, DLX: `dropshield.booking`, DLK: `booking.requested` |

### Progressive Delay Retry Mechanism
Instead of immediate infinite retry loops that overwhelm databases:
1. Failed consumer attempts are assigned an incremental `x-retry-count` header.
2. Messages are published to `dropshield.booking.retry` with key `booking.retry.{N}`.
3. The retry queue holds the message until its `messageTtl` expires.
4. RabbitMQ's dead-letter routing automatically forwards the expired message back to the main exchange with routing key `booking.requested`.
5. If `x-retry-count >= 3`, the message is permanently diverted to the Dead-Letter Queue (`dropshield.booking.dead`) and acknowledged.

---

## 3. Transactional Outbox Pattern

To prevent two-phase commit inconsistencies between PostgreSQL and RabbitMQ, the API **never** publishes directly to RabbitMQ in the user request path.

### 1. Atomic Database Commit
Within a single database transaction (`BEGIN ... COMMIT`):
- Inserts `reservations`
- Inserts `reservation_items`
- Updates `session_seats` to `HELD`
- Inserts `outbox_events` with `status = 'PENDING'`

If any database error occurs, the entire transaction rolls back, and no outbox event is created.

### 2. Reliable Publisher Relay
- **Row Locking**: The publisher claims pending events using PostgreSQL `FOR UPDATE SKIP LOCKED`, allowing multiple parallel publishers without locking contention or race collisions:
  ```sql
  WITH candidates AS (
    SELECT id FROM outbox_events
    WHERE (status = 'PENDING' AND available_at <= CURRENT_TIMESTAMP)
       OR (status = 'PROCESSING' AND locked_at < CURRENT_TIMESTAMP - ($2 * INTERVAL '1 minute'))
    ORDER BY available_at ASC
    LIMIT $1
    FOR UPDATE SKIP LOCKED
  )
  UPDATE outbox_events
  SET status = 'PROCESSING',
      locked_at = CURRENT_TIMESTAMP,
      locked_by = $3
  FROM candidates
  WHERE outbox_events.id = candidates.id
  RETURNING outbox_events.*;
  ```
- **Publisher Confirms**: Publishes via RabbitMQ `ConfirmChannel` with `persistent: true`.
- **Status Advancement**: Only when RabbitMQ acknowledges durable persistence does the publisher execute:
  ```sql
  UPDATE outbox_events
  SET status = 'PUBLISHED', published_at = CURRENT_TIMESTAMP, locked_at = NULL
  WHERE id = $1;
  ```
- **Crash Recovery**: If a publisher process crashes while holding locked rows, the `locked_at < CURRENT_TIMESTAMP - INTERVAL '1 minute'` clause automatically frees stale records for subsequent recovery sweeps.

---

## 4. Message Schema & Versioning

```json
{
  "eventId": "e202aeab-cd2a-42fe-bd3b-d1ba675532cb",
  "eventType": "booking.requested",
  "version": "v1",
  "timestamp": "2026-11-13T15:46:47.662Z",
  "payload": {
    "reservationId": "c7ecdbdd-4853-4b22-ba4b-ae43a6bde217",
    "sessionId": "99e5d01e-eee7-4de3-a898-2c6014fe4c74",
    "userId": "d869abb9-a822-47ec-8286-860f1782a136",
    "seatIds": [
      "80cbfe21-120d-4b69-8787-8dff4dbee7b9",
      "91cbfe21-120d-4b69-8787-8dff4dbee7c0"
    ],
    "idempotencyKey": "idemp-flow-7c89f",
    "expiresAt": "2026-11-13T15:56:47.000Z",
    "totalAmountMinor": 300000,
    "currency": "INR"
  },
  "retryCount": 0
}
```

---

## 5. API Endpoints & Contract Examples

### 5.1. POST `/api/v1/sessions/:sessionId/reservations`
Initiates an asynchronous seat reservation.

**Headers:**
- `Authorization: Bearer <token>`
- `X-Idempotency-Key: idemp-stadium-a1-12345`

**Request Body:**
```json
{
  "seatIds": [
    "80cbfe21-120d-4b69-8787-8dff4dbee7b9",
    "91cbfe21-120d-4b69-8787-8dff4dbee7c0"
  ]
}
```

**Response (HTTP 202 Accepted):**
```json
{
  "success": true,
  "data": {
    "reservationId": "c7ecdbdd-4853-4b22-ba4b-ae43a6bde217",
    "status": "PENDING",
    "sessionId": "99e5d01e-eee7-4de3-a898-2c6014fe4c74",
    "seatIds": [
      "80cbfe21-120d-4b69-8787-8dff4dbee7b9",
      "91cbfe21-120d-4b69-8787-8dff4dbee7c0"
    ],
    "expiresAt": "2026-11-13T15:58:59.000Z",
    "acceptedAt": "2026-11-13T15:48:59.070Z",
    "statusUrl": "/api/v1/reservations/c7ecdbdd-4853-4b22-ba4b-ae43a6bde217"
  },
  "timestamp": "2026-11-13T15:48:59.070Z"
}
```

### 5.2. GET `/api/v1/reservations/:reservationId`
Retrieves durable status from PostgreSQL.

**Response (HTTP 200 OK):**
```json
{
  "success": true,
  "data": {
    "reservationId": "c7ecdbdd-4853-4b22-ba4b-ae43a6bde217",
    "sessionId": "99e5d01e-eee7-4de3-a898-2c6014fe4c74",
    "userId": "d869abb9-a822-47ec-8286-860f1782a136",
    "status": "PENDING",
    "expiresAt": "2026-11-13T15:58:59.000Z",
    "totalAmountMinor": 300000,
    "currency": "INR",
    "bookingId": null,
    "bookingStatus": null,
    "confirmedAt": null,
    "createdAt": "2026-11-13T15:48:59.020Z",
    "updatedAt": "2026-11-13T15:48:59.020Z"
  },
  "timestamp": "2026-11-13T15:48:59.147Z"
}
```

---

## 6. Failure Recovery Matrix

| Failure Scenario | Recovery & Consistency Guarantee |
| :--- | :--- |
| **Redis hold succeeds, PostgreSQL write fails** | Safe compensation automatically invokes `inventoryService.releaseSeats({ reason: 'COMPENSATION_ROLLBACK' })`. Redis inventory is immediately released back to `AVAILABLE`. Returns HTTP 500. |
| **PostgreSQL commits, RabbitMQ unavailable** | Outbox event is already committed as `PENDING` in PostgreSQL. When RabbitMQ recovers, the outbox relay service claims the event and publishes it with confirmation. Zero data loss. |
| **Publisher crashes mid-flight** | Row lock expires after 1 minute (`locked_at < NOW - 1 min`). The next polling iteration recovers the event and publishes it. |
| **Publisher confirms, but crashes before DB update** | Message is in RabbitMQ. When redelivered or published again, the consumer checks idempotency in PostgreSQL: if already processed, it simply ACKs. |
| **Worker crashes before DB commit** | Unacknowledged message is requeued by RabbitMQ to another active consumer. Transaction is safely retried. |
| **Worker crashes after DB commit, before ACK** | Re-delivered message encounters an already updated record; the consumer detects idempotent state and ACKs immediately. |
| **Corrupted or invalid payload reaches worker** | Worker validates schema and version (`v1`); rejects message without requeue, causing immediate dead-letter routing to `dropshield.booking.dead`. |
| **Reservation lease expires while waiting in queue** | Worker detects `Date.now() >= expiresAt`, marks reservation as `EXPIRED` in PostgreSQL, releases seats in Redis, and ACKs the message. |

---

## 7. Automated Test Suite Matrix

The engine is validated with 22 automated integration tests running against real PostgreSQL, Redis, and RabbitMQ:

| Test Suite | Tests | Key Behaviors Verified |
| :--- | :--- | :--- |
| `tests/rabbitmq-connection.test.ts` | 4 | Credential sanitization in AMQP URLs, live broker health check, idempotent topology assertion, publisher confirms |
| `tests/outbox-publisher.test.ts` | 4 | Transactional outbox creation, `FOR UPDATE SKIP LOCKED` concurrency, publisher confirm transition to `PUBLISHED`, crash recovery |
| `tests/booking-api.test.ts` | 10 | Security auth guard, validation rules, 202 Accepted lifecycle, idempotency replay vs conflict, Redis compensation rollback |
| `tests/booking-worker.test.ts` | 4 | Queue consumption & state transition, duplicate redelivery idempotency, in-queue lease expiration cleanup, dead-letter routing |
