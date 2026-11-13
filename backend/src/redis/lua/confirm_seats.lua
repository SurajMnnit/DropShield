-- ==============================================================================
-- confirm_seats.lua
-- DropShield Phase 4: Atomic Seat Booking Confirmation Engine
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
--   ARGV[2] = userId (UUID)
--   ARGV[3] = nowMs (string number)
-- ==============================================================================

local seats_key = KEYS[1]
local reservation_key = KEYS[2]
local res_seats_key = KEYS[3]
local expirations_key = KEYS[4]
local idempotency_key = KEYS[5]

local reservation_id = ARGV[1]
local user_id = ARGV[2]
local now_ms = tonumber(ARGV[3])

-- ------------------------------------------------------------------------------
-- 1. Check Reservation Existence
-- ------------------------------------------------------------------------------
local exists = redis.call('EXISTS', reservation_key)
if exists == 0 then
    return cjson.encode({
        success = false,
        error = "RESERVATION_NOT_FOUND",
        message = "Reservation does not exist or has expired and been removed."
    })
end

-- ------------------------------------------------------------------------------
-- 2. Verify User Ownership
-- ------------------------------------------------------------------------------
local stored_user_id = redis.call('HGET', reservation_key, 'user_id')
if stored_user_id ~= user_id then
    return cjson.encode({
        success = false,
        error = "UNAUTHORIZED_USER",
        message = "User does not own this reservation."
    })
end

-- ------------------------------------------------------------------------------
-- 3. Verify Reservation State & Handle Idempotent Double-Confirmation
-- ------------------------------------------------------------------------------
local current_status = redis.call('HGET', reservation_key, 'status')
if current_status == "BOOKED" then
    -- Safe idempotent handling of duplicate confirmation calls
    local confirmed_seats = redis.call('SMEMBERS', res_seats_key)
    return cjson.encode({
        success = true,
        status = "ALREADY_CONFIRMED",
        reservationId = reservation_id,
        reservation_id = reservation_id,
        seats = confirmed_seats,
        message = "Reservation has already been confirmed as BOOKED."
    })
end

if current_status ~= "HELD" then
    return cjson.encode({
        success = false,
        error = "INVALID_RESERVATION_STATUS",
        currentStatus = current_status,
        current_status = current_status,
        message = "Reservation is not in HELD state (current: " .. tostring(current_status) .. ")."
    })
end

-- ------------------------------------------------------------------------------
-- 4. Expiration Validation
-- ------------------------------------------------------------------------------
local expires_at = tonumber(redis.call('HGET', reservation_key, 'expires_at'))
if expires_at and expires_at < now_ms then
    return cjson.encode({
        success = false,
        error = "RESERVATION_EXPIRED",
        expiresAt = expires_at,
        expires_at = expires_at,
        now = now_ms,
        message = "Reservation hold has expired. Cannot confirm booking."
    })
end

-- ------------------------------------------------------------------------------
-- 5. Pre-Check All Associated Seats
-- Every seat must still be in HELD status in the session inventory.
-- If any seat is missing or not HELD, abort immediately!
-- ------------------------------------------------------------------------------
local held_seats = redis.call('SMEMBERS', res_seats_key)
if #held_seats == 0 then
    return cjson.encode({
        success = false,
        error = "NO_SEATS_ASSOCIATED",
        message = "No seats found associated with this reservation."
    })
end

for _, seat_id in ipairs(held_seats) do
    local seat_status = redis.call('HGET', seats_key, seat_id)
    if seat_status ~= "HELD" then
        return cjson.encode({
            success = false,
            error = "SEAT_STATE_CONFLICT",
            seatId = seat_id,
            seat_id = seat_id,
            currentStatus = seat_status,
            current_status = seat_status,
            message = "Seat " .. tostring(seat_id) .. " is not in HELD state (current: " .. tostring(seat_status) .. ")."
        })
    end
end

-- ------------------------------------------------------------------------------
-- 6. Atomic Transition to BOOKED
-- ------------------------------------------------------------------------------
for _, seat_id in ipairs(held_seats) do
    redis.call('HSET', seats_key, seat_id, "BOOKED")
end

-- ------------------------------------------------------------------------------
-- 7. Update Reservation Metadata
-- ------------------------------------------------------------------------------
redis.call('HSET', reservation_key, 'status', 'BOOKED')
redis.call('HSET', reservation_key, 'confirmed_at', now_ms)

-- Remove from expiration sorted set
redis.call('ZREM', expirations_key, reservation_id)

-- ------------------------------------------------------------------------------
-- 8. Update Idempotency Record (if present)
-- ------------------------------------------------------------------------------
if idempotency_key and idempotency_key ~= "" and redis.call('EXISTS', idempotency_key) == 1 then
    redis.call('HSET', idempotency_key, 'status', 'BOOKED')
end

return cjson.encode({
    success = true,
    status = "SUCCESS",
    reservationId = reservation_id,
    reservation_id = reservation_id,
    confirmedCount = #held_seats,
    confirmed_count = #held_seats,
    seats = held_seats
})
