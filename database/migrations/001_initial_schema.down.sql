-- Migration: 001_initial_schema.down.sql
-- DropShield Phase 3: PostgreSQL Schema Rollback (Clean Reverse Order)

DROP TRIGGER IF EXISTS trg_ledger_immutable_stmt ON transaction_ledger CASCADE;
DROP TRIGGER IF EXISTS trg_ledger_immutable_row ON transaction_ledger CASCADE;
DROP TRIGGER IF EXISTS trg_ledger_immutable ON transaction_ledger CASCADE;
DROP FUNCTION IF EXISTS trg_prevent_ledger_modification() CASCADE;

DROP TABLE IF EXISTS transaction_ledger CASCADE;
DROP TABLE IF EXISTS outbox_events CASCADE;
DROP TABLE IF EXISTS idempotency_records CASCADE;
DROP TABLE IF EXISTS payments CASCADE;
DROP TABLE IF EXISTS booking_items CASCADE;
DROP TABLE IF EXISTS reservation_items CASCADE;
DROP TABLE IF EXISTS session_seats CASCADE;
DROP TABLE IF EXISTS bookings CASCADE;
DROP TABLE IF EXISTS reservations CASCADE;
DROP TABLE IF EXISTS event_sessions CASCADE;
DROP TABLE IF EXISTS events CASCADE;
DROP TABLE IF EXISTS venue_seats CASCADE;
DROP TABLE IF EXISTS venues CASCADE;
DROP TABLE IF EXISTS users CASCADE;
