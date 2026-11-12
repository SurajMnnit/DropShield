-- Migration: 001_initial_schema.up.sql
-- DropShield Phase 3: PostgreSQL Database Schema (Final Hardened Edition)
-- High-concurrency Event Ticketing Engine with Multi-Tier Composite Integrity Constraints

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- =============================================================================
-- A. USERS
-- =============================================================================
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    email VARCHAR(255) NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    role VARCHAR(50) NOT NULL DEFAULT 'buyer',
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_users_role CHECK (role IN ('buyer', 'admin'))
);

-- Case-insensitive and whitespace-normalized email uniqueness
CREATE UNIQUE INDEX IF NOT EXISTS uq_users_normalized_email ON users (LOWER(BTRIM(email)));

-- =============================================================================
-- B. VENUES
-- =============================================================================
CREATE TABLE IF NOT EXISTS venues (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    address TEXT NOT NULL,
    city VARCHAR(100) NOT NULL,
    state VARCHAR(100) NOT NULL,
    country VARCHAR(100) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- =============================================================================
-- C. VENUE SEATS (Physical seats within a venue)
-- =============================================================================
CREATE TABLE IF NOT EXISTS venue_seats (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    venue_id UUID NOT NULL REFERENCES venues(id) ON DELETE RESTRICT,
    section VARCHAR(100) NOT NULL,
    row_label VARCHAR(50) NOT NULL,
    seat_number VARCHAR(50) NOT NULL,
    seat_type VARCHAR(50) NOT NULL DEFAULT 'STANDARD',
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_venue_seats_physical_seat UNIQUE (venue_id, section, row_label, seat_number),
    -- Composite unique key to enforce venue-to-session integrity
    CONSTRAINT uq_venue_seats_id_venue UNIQUE (id, venue_id)
);

CREATE INDEX IF NOT EXISTS idx_venue_seats_venue_section ON venue_seats (venue_id, section);

-- =============================================================================
-- D. EVENTS
-- =============================================================================
CREATE TABLE IF NOT EXISTS events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title VARCHAR(255) NOT NULL,
    description TEXT,
    category VARCHAR(100) NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'DRAFT',
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_events_status CHECK (status IN ('DRAFT', 'PUBLISHED', 'ARCHIVED', 'CANCELLED'))
);

CREATE INDEX IF NOT EXISTS idx_events_status_category ON events (status, category);

-- =============================================================================
-- E. EVENT SESSIONS (Scheduled occurrence of an event at a venue)
-- =============================================================================
CREATE TABLE IF NOT EXISTS event_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id UUID NOT NULL REFERENCES events(id) ON DELETE RESTRICT,
    venue_id UUID NOT NULL REFERENCES venues(id) ON DELETE RESTRICT,
    starts_at TIMESTAMPTZ NOT NULL,
    ends_at TIMESTAMPTZ NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'SCHEDULED',
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_event_sessions_status CHECK (status IN ('SCHEDULED', 'OPEN', 'COMPLETED', 'CANCELLED', 'POSTPONED')),
    CONSTRAINT chk_event_sessions_time_range CHECK (ends_at > starts_at),
    -- Composite unique key to enforce venue matching in session_seats
    CONSTRAINT uq_event_sessions_id_venue UNIQUE (id, venue_id)
);

CREATE INDEX IF NOT EXISTS idx_event_sessions_event_starts ON event_sessions (event_id, starts_at);
CREATE INDEX IF NOT EXISTS idx_event_sessions_venue ON event_sessions (venue_id);

-- =============================================================================
-- F. RESERVATIONS (Temporary seat hold)
-- =============================================================================
CREATE TABLE IF NOT EXISTS reservations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    event_session_id UUID NOT NULL REFERENCES event_sessions(id) ON DELETE RESTRICT,
    status VARCHAR(50) NOT NULL DEFAULT 'PENDING',
    expires_at TIMESTAMPTZ NOT NULL,
    total_amount_minor BIGINT NOT NULL DEFAULT 0,
    currency VARCHAR(3) NOT NULL DEFAULT 'INR',
    idempotency_key VARCHAR(255) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_reservations_status CHECK (status IN ('PENDING', 'CONFIRMED', 'EXPIRED', 'CANCELLED', 'FAILED')),
    CONSTRAINT chk_reservations_amount CHECK (total_amount_minor >= 0),
    CONSTRAINT uq_reservations_user_idempotency UNIQUE (user_id, idempotency_key),
    -- Composite unique keys for session and user-ownership integrity
    CONSTRAINT uq_reservations_id_session UNIQUE (id, event_session_id),
    CONSTRAINT uq_reservations_id_user_session UNIQUE (id, user_id, event_session_id)
);

CREATE INDEX IF NOT EXISTS idx_reservations_pending_expires ON reservations (expires_at) WHERE status = 'PENDING';
CREATE INDEX IF NOT EXISTS idx_reservations_user_status ON reservations (user_id, status);
CREATE INDEX IF NOT EXISTS idx_reservations_session_status ON reservations (event_session_id, status);

-- =============================================================================
-- H. BOOKINGS (Confirmed bookings created from a reservation)
-- =============================================================================
CREATE TABLE IF NOT EXISTS bookings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    reservation_id UUID NOT NULL UNIQUE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    event_session_id UUID NOT NULL REFERENCES event_sessions(id) ON DELETE RESTRICT,
    status VARCHAR(50) NOT NULL DEFAULT 'CONFIRMED',
    total_amount_minor BIGINT NOT NULL,
    currency VARCHAR(3) NOT NULL DEFAULT 'INR',
    confirmed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_bookings_status CHECK (status IN ('CONFIRMED', 'CANCELLED', 'REFUNDED')),
    CONSTRAINT chk_bookings_amount CHECK (total_amount_minor >= 0),
    -- Composite unique keys
    CONSTRAINT uq_bookings_id_session UNIQUE (id, event_session_id),
    CONSTRAINT uq_bookings_id_user UNIQUE (id, user_id),
    -- Composite FK: Enforces booking user AND session match reservation user AND session
    CONSTRAINT fk_bookings_reservation_user_session FOREIGN KEY (reservation_id, user_id, event_session_id) 
        REFERENCES reservations (id, user_id, event_session_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_bookings_user_session ON bookings (user_id, event_session_id);
CREATE INDEX IF NOT EXISTS idx_bookings_session ON bookings (event_session_id);

-- =============================================================================
-- J. SESSION SEATS (Authoritative per-session seat inventory state)
-- =============================================================================
CREATE TABLE IF NOT EXISTS session_seats (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_session_id UUID NOT NULL,
    venue_id UUID NOT NULL,
    venue_seat_id UUID NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'AVAILABLE',
    current_reservation_id UUID,
    current_booking_id UUID,
    hold_expires_at TIMESTAMPTZ,
    price_minor BIGINT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_session_seats_session_venue_seat UNIQUE (event_session_id, venue_seat_id),
    CONSTRAINT uq_session_seats_id_session UNIQUE (id, event_session_id),
    CONSTRAINT chk_session_seats_status CHECK (status IN ('AVAILABLE', 'HELD', 'BOOKED')),
    CONSTRAINT chk_session_seats_price CHECK (price_minor >= 0),
    -- Strict Inventory State Integrity Constraint:
    -- 1. AVAILABLE: current_reservation_id, current_booking_id, and hold_expires_at MUST all be NULL.
    -- 2. HELD: current_reservation_id and hold_expires_at MUST NOT be NULL; current_booking_id MUST be NULL.
    -- 3. BOOKED: current_booking_id MUST NOT be NULL; current_reservation_id and hold_expires_at MUST be NULL.
    CONSTRAINT chk_session_seats_state_integrity CHECK (
        (
            status = 'AVAILABLE'
            AND current_reservation_id IS NULL
            AND current_booking_id IS NULL
            AND hold_expires_at IS NULL
        )
        OR
        (
            status = 'HELD'
            AND current_reservation_id IS NOT NULL
            AND current_booking_id IS NULL
            AND hold_expires_at IS NOT NULL
        )
        OR
        (
            status = 'BOOKED'
            AND current_reservation_id IS NULL
            AND current_booking_id IS NOT NULL
            AND hold_expires_at IS NULL
        )
    ),
    -- Composite FK: Guarantees event_session belongs to this venue (ON DELETE RESTRICT preserves historical inventory)
    CONSTRAINT fk_session_seats_session_venue FOREIGN KEY (event_session_id, venue_id)
        REFERENCES event_sessions (id, venue_id) ON DELETE RESTRICT,
    -- Composite FK: Guarantees venue_seat belongs to the hosting venue!
    -- Rejects associating a seat from Venue B with a session at Venue A
    CONSTRAINT fk_session_seats_venue_seat FOREIGN KEY (venue_seat_id, venue_id)
        REFERENCES venue_seats (id, venue_id) ON DELETE RESTRICT,
    -- Composite FK: Ensures active reservation belongs to this exact session (ON DELETE RESTRICT)
    CONSTRAINT fk_session_seats_active_reservation FOREIGN KEY (current_reservation_id, event_session_id)
        REFERENCES reservations (id, event_session_id) ON DELETE RESTRICT,
    -- Composite FK: Ensures active booking belongs to this exact session (ON DELETE RESTRICT)
    CONSTRAINT fk_session_seats_active_booking FOREIGN KEY (current_booking_id, event_session_id)
        REFERENCES bookings (id, event_session_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_session_seats_session_status ON session_seats (event_session_id, status);
CREATE INDEX IF NOT EXISTS idx_session_seats_held_expiry ON session_seats (hold_expires_at) WHERE status = 'HELD';
CREATE INDEX IF NOT EXISTS idx_session_seats_reservation ON session_seats (current_reservation_id) WHERE current_reservation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_session_seats_booking ON session_seats (current_booking_id) WHERE current_booking_id IS NOT NULL;

-- =============================================================================
-- G. RESERVATION ITEMS (Preserves Historical Hold Snapshots)
-- =============================================================================
CREATE TABLE IF NOT EXISTS reservation_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    reservation_id UUID NOT NULL,
    event_session_id UUID NOT NULL,
    session_seat_id UUID NOT NULL,
    unit_price_minor BIGINT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_reservation_items_price CHECK (unit_price_minor >= 0),
    CONSTRAINT uq_reservation_items_reservation_seat UNIQUE (reservation_id, session_seat_id),
    -- Preserves historical reservation audit trail (RESTRICT prevents accidental cascade purge)
    CONSTRAINT fk_reservation_items_parent FOREIGN KEY (reservation_id, event_session_id)
        REFERENCES reservations (id, event_session_id) ON DELETE RESTRICT,
    -- Composite FK to session_seats guarantees seat matches session
    CONSTRAINT fk_reservation_items_seat_session FOREIGN KEY (session_seat_id, event_session_id)
        REFERENCES session_seats (id, event_session_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_reservation_items_reservation ON reservation_items (reservation_id);
CREATE INDEX IF NOT EXISTS idx_reservation_items_session_seat ON reservation_items (session_seat_id);

-- =============================================================================
-- I. BOOKING ITEMS (Preserves Historical Confirmed Ticket Snapshots)
-- =============================================================================
CREATE TABLE IF NOT EXISTS booking_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    booking_id UUID NOT NULL,
    event_session_id UUID NOT NULL,
    session_seat_id UUID NOT NULL,
    unit_price_minor BIGINT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_booking_items_price CHECK (unit_price_minor >= 0),
    CONSTRAINT uq_booking_items_booking_seat UNIQUE (booking_id, session_seat_id),
    -- Preserves historical booking audit trail (RESTRICT prevents accidental purge)
    CONSTRAINT fk_booking_items_parent FOREIGN KEY (booking_id, event_session_id)
        REFERENCES bookings (id, event_session_id) ON DELETE RESTRICT,
    -- Composite FK to session_seats guarantees seat matches session
    CONSTRAINT fk_booking_items_seat_session FOREIGN KEY (session_seat_id, event_session_id)
        REFERENCES session_seats (id, event_session_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_booking_items_booking ON booking_items (booking_id);
CREATE INDEX IF NOT EXISTS idx_booking_items_session_seat ON booking_items (session_seat_id);

-- =============================================================================
-- K. PAYMENTS (Enforces User Ownership of Booking)
-- =============================================================================
CREATE TABLE IF NOT EXISTS payments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    booking_id UUID NOT NULL,
    user_id UUID NOT NULL,
    amount_minor BIGINT NOT NULL,
    currency VARCHAR(3) NOT NULL DEFAULT 'INR',
    provider VARCHAR(50) NOT NULL,
    provider_payment_id VARCHAR(255),
    idempotency_key VARCHAR(255) NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'PENDING',
    failure_reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_payments_status CHECK (status IN ('PENDING', 'SUCCEEDED', 'FAILED', 'REFUNDED')),
    CONSTRAINT chk_payments_amount CHECK (amount_minor > 0),
    CONSTRAINT uq_payments_user_idempotency UNIQUE (user_id, idempotency_key),
    -- Composite FK: Enforces payments.user_id matches bookings.user_id!
    CONSTRAINT fk_payments_booking_user FOREIGN KEY (booking_id, user_id)
        REFERENCES bookings (id, user_id) ON DELETE RESTRICT
);

-- Provider payment capture uniqueness
CREATE UNIQUE INDEX IF NOT EXISTS uq_payments_provider_payment_id ON payments (provider, provider_payment_id) 
WHERE provider_payment_id IS NOT NULL;

-- Allow multiple attempts for a booking, but prevent multiple SUCCEEDED payments on the same booking
CREATE UNIQUE INDEX IF NOT EXISTS uq_payments_booking_succeeded ON payments (booking_id) 
WHERE status = 'SUCCEEDED';

CREATE INDEX IF NOT EXISTS idx_payments_booking_status ON payments (booking_id, status);
CREATE INDEX IF NOT EXISTS idx_payments_user ON payments (user_id);

-- =============================================================================
-- L. IDEMPOTENCY RECORDS
-- =============================================================================
CREATE TABLE IF NOT EXISTS idempotency_records (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    idempotency_key VARCHAR(255) NOT NULL,
    operation VARCHAR(100) NOT NULL,
    request_hash VARCHAR(64) NOT NULL,
    response_status INTEGER,
    response_body JSONB,
    status VARCHAR(50) NOT NULL DEFAULT 'IN_PROGRESS',
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_idempotency_status CHECK (status IN ('IN_PROGRESS', 'COMPLETED', 'FAILED')),
    CONSTRAINT uq_idempotency_user_op_key UNIQUE (user_id, operation, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_idempotency_expires_at ON idempotency_records (expires_at);

-- =============================================================================
-- M. OUTBOX EVENTS (Reliable Transactional Outbox Pattern with Crash Recovery)
-- =============================================================================
CREATE TABLE IF NOT EXISTS outbox_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    aggregate_type VARCHAR(100) NOT NULL,
    aggregate_id VARCHAR(255) NOT NULL,
    event_type VARCHAR(100) NOT NULL,
    payload JSONB NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'PENDING',
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 5,
    available_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    locked_at TIMESTAMPTZ,
    locked_by VARCHAR(255),
    last_error TEXT,
    published_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_outbox_events_status CHECK (status IN ('PENDING', 'PROCESSING', 'PUBLISHED', 'FAILED')),
    CONSTRAINT chk_outbox_events_attempts CHECK (attempts >= 0),
    CONSTRAINT chk_outbox_events_max_attempts CHECK (max_attempts > 0)
);

-- Index for polling pending events as well as stale PROCESSING events for recovery
CREATE INDEX IF NOT EXISTS idx_outbox_events_pending_polling ON outbox_events (status, available_at, locked_at) 
WHERE status IN ('PENDING', 'PROCESSING');

-- =============================================================================
-- N. TRANSACTION LEDGER (Immutable Financial Transaction Audit Ledger)
-- =============================================================================
CREATE TABLE IF NOT EXISTS transaction_ledger (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    payment_id UUID REFERENCES payments(id) ON DELETE RESTRICT,
    booking_id UUID NOT NULL REFERENCES bookings(id) ON DELETE RESTRICT,
    transaction_type VARCHAR(50) NOT NULL,
    amount_minor BIGINT NOT NULL,
    currency VARCHAR(3) NOT NULL DEFAULT 'INR',
    reference VARCHAR(255) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_ledger_type CHECK (transaction_type IN ('CHARGE', 'REFUND', 'REVERSAL', 'ADJUSTMENT')),
    CONSTRAINT chk_ledger_amount CHECK (amount_minor > 0),
    CONSTRAINT uq_ledger_booking_type_ref UNIQUE (booking_id, transaction_type, reference)
);

CREATE INDEX IF NOT EXISTS idx_ledger_booking_payment ON transaction_ledger (booking_id, payment_id);

-- Enforce strict immutability: block UPDATE, DELETE, and TRUNCATE at database level
CREATE OR REPLACE FUNCTION trg_prevent_ledger_modification()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'transaction_ledger entries are strictly immutable: UPDATE, DELETE, and TRUNCATE are prohibited';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_ledger_immutable_row ON transaction_ledger;
CREATE TRIGGER trg_ledger_immutable_row
BEFORE UPDATE OR DELETE ON transaction_ledger
FOR EACH ROW EXECUTE FUNCTION trg_prevent_ledger_modification();

DROP TRIGGER IF EXISTS trg_ledger_immutable_stmt ON transaction_ledger;
CREATE TRIGGER trg_ledger_immutable_stmt
BEFORE TRUNCATE ON transaction_ledger
FOR EACH STATEMENT EXECUTE FUNCTION trg_prevent_ledger_modification();
