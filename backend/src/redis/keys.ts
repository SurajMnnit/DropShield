/**
 * Redis Key Architecture for DropShield
 *
 * CRITICAL CLUSTER DESIGN:
 * All keys belonging to the same session share the Redis Cluster hash tag `{sessionId}`.
 * This guarantees that all keys manipulated by a multi-key Lua transaction reside on
 * the exact same hash slot (calculated as CRC16(sessionId) % 16384), eliminating
 * any potential CROSSSLOT errors in distributed Redis Cluster deployments.
 */

export const RedisKeys = {
  /**
   * Session seat inventory hash.
   * Type: HASH
   * Key: dropshield:{sessionId}:seats
   * Fields: seatId -> status ("AVAILABLE" | "HELD" | "BOOKED")
   */
  sessionSeats(sessionId: string): string {
    return `dropshield:{${sessionId}}:seats`;
  },

  /**
   * Reservation metadata hash.
   * Type: HASH
   * Key: dropshield:{sessionId}:reservation:{reservationId}
   * Fields: id, user_id, status, created_at, expires_at, request_hash, seat_count
   */
  reservationMeta(sessionId: string, reservationId: string): string {
    return `dropshield:{${sessionId}}:reservation:${reservationId}`;
  },

  /**
   * Reservation seat mapping set.
   * Type: SET
   * Key: dropshield:{sessionId}:reservation:{reservationId}:seats
   * Members: seatId strings
   */
  reservationSeats(sessionId: string, reservationId: string): string {
    return `dropshield:{${sessionId}}:reservation:${reservationId}:seats`;
  },

  /**
   * Reservation expiration sorted set index.
   * Type: ZSET
   * Key: dropshield:{sessionId}:reservation_expirations
   * Score: expiresAt timestamp in milliseconds
   * Member: reservationId
   */
  reservationExpirations(sessionId: string): string {
    return `dropshield:{${sessionId}}:reservation_expirations`;
  },

  /**
   * Idempotency record hash.
   * Type: HASH
   * Key: dropshield:{sessionId}:idempotency:{userId}:{idempotencyKey}
   * Fields: reservation_id, request_hash, status, created_at
   */
  idempotency(sessionId: string, userId: string, idempotencyKey: string): string {
    return `dropshield:{${sessionId}}:idempotency:${userId}:${idempotencyKey}`;
  },
};
