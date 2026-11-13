-- ==============================================================================
-- release_seats.lua
-- DropShield Phase 4: Atomic Seat Release & Expiry Engine
-- ==============================================================================
-- KEYS:
--   KEYS[1] = dropshield:{sessionId}:seats
--   KEYS[2] = dropshield:{sessionId}:reservation:{reservationId}
--   KEYS[3] = dropshield:{sessionId}:reservation:{reservationId}:seats
--   KEYS[4] = dropshield:{sessionId}:reservation_expirations
--   KEYS[5] = dropshield:{sessionId}:idempotency:{userId}:{idempotencyKey} (optional / empty string)
--
-- ARGV:
--   ARGV[1] = reservationId (UUID)
--   ARGV[2] = userId (UUID or "SYSTEM" / "SYSTEM_EXPIRY" / "FORCE")
--   ARGV[3] = reason ("EXPIRED" | "CANCELLED" | "MANUAL")
--   ARGV[4] = nowMs (string number)
-- ==============================================================================

local seats_key = KEYS[1]
local reservation_key = KEYS[2]
local res_seats_key = KEYS[3]
local expirations_key = KEYS[4]
local idempotency_key = KEYS[5]

local reservation_id = ARGV[1]
local user_id = ARGV[2]
local reason = ARGV[3] or "EXPIRED"
local now_ms = tonumber(ARGV[4])

-- ------------------------------------------------------------------------------
-- 1. Check Reservation Existence
-- ------------------------------------------------------------------------------
local exists = redis.call('EXISTS', reservation_key)
if exists == 0 then
    -- Safe / idempotent handling: already purged or non-existent
    return cjson.encode({
        success = true,
        status = "RESERVATION_NOT_FOUND",
        message = "Reservation does not exist or has already been pruned."
    })
end

-- ------------------------------------------------------------------------------
-- 2. Verify Reservation State
-- ------------------------------------------------------------------------------
local current_status = redis.call('HGET', reservation_key, 'status')
if current_status == "BOOKED" then
    return cjson.encode({
        success = false,
        error = "RESERVATION_ALREADY_CONFIRMED",
        message = "Cannot release a reservation that has already been confirmed as BOOKED."
    })
end

if current_status == "EXPIRED" or current_status == "CANCELLED" or current_status == "RELEASED" then
    return cjson.encode({
        success = true,
        status = "ALREADY_RELEASED",
        currentStatus = current_status,
        current_status = current_status,
        message = "Reservation has already been released."
    })
end

-- ------------------------------------------------------------------------------
-- 3. Verify Ownership (Bypassed for System Expiry Sweeper)
-- ------------------------------------------------------------------------------
if user_id ~= "SYSTEM" and user_id ~= "SYSTEM_EXPIRY" and user_id ~= "FORCE" then
    local stored_user_id = redis.call('HGET', reservation_key, 'user_id')
    if stored_user_id ~= user_id then
        return cjson.encode({
            success = false,
            error = "UNAUTHORIZED_USER",
            message = "User does not possess ownership of this reservation."
        })
    end
end

-- ------------------------------------------------------------------------------
-- 4. Safe Seat Release
-- Only release a seat if it is still currently HELD.
-- Prevents a delayed or stale expiry event from reverting a reallocated seat!
-- ------------------------------------------------------------------------------
local held_seats = redis.call('SMEMBERS', res_seats_key)
local released_count = 0

for _, seat_id in ipairs(held_seats) do
    local seat_status = redis.call('HGET', seats_key, seat_id)
    if seat_status == "HELD" then
        redis.call('HSET', seats_key, seat_id, "AVAILABLE")
        released_count = released_count + 1
    end
end

-- ------------------------------------------------------------------------------
-- 5. Update Reservation State
-- ------------------------------------------------------------------------------
redis.call('HSET', reservation_key, 'status', reason)
redis.call('HSET', reservation_key, 'released_at', now_ms)

-- Remove from the expiration sorted set
redis.call('ZREM', expirations_key, reservation_id)

-- ------------------------------------------------------------------------------
-- 6. Update Idempotency Record (if provided and valid)
-- ------------------------------------------------------------------------------
if idempotency_key and idempotency_key ~= "" and redis.call('EXISTS', idempotency_key) == 1 then
    redis.call('HSET', idempotency_key, 'status', reason)
end

return cjson.encode({
    success = true,
    status = "SUCCESS",
    reservationId = reservation_id,
    reservation_id = reservation_id,
    reason = reason,
    releasedCount = released_count,
    released_count = released_count,
    seats = held_seats
})
