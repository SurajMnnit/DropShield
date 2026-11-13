-- ==============================================================================
-- hold_seats.lua
-- DropShield Phase 4: Atomic Seat Hold Engine
-- ==============================================================================
-- KEYS:
--   KEYS[1] = dropshield:{sessionId}:seats
--   KEYS[2] = dropshield:{sessionId}:reservation:{reservationId}
--   KEYS[3] = dropshield:{sessionId}:reservation:{reservationId}:seats
--   KEYS[4] = dropshield:{sessionId}:reservation_expirations
--   KEYS[5] = dropshield:{sessionId}:idempotency:{userId}:{idempotencyKey}
--
-- ARGV:
--   ARGV[1] = reservationId (UUID)
--   ARGV[2] = userId (UUID)
--   ARGV[3] = nowMs (string number)
--   ARGV[4] = expiresAtMs (string number)
--   ARGV[5] = requestHash (SHA-256 string)
--   ARGV[6] = ttlSeconds (string number)
--   ARGV[7...] = seatId list (strings)
-- ==============================================================================

local seats_key = KEYS[1]
local reservation_key = KEYS[2]
local res_seats_key = KEYS[3]
local expirations_key = KEYS[4]
local idempotency_key = KEYS[5]

local reservation_id = ARGV[1]
local user_id = ARGV[2]
local now_ms = tonumber(ARGV[3])
local expires_at_ms = tonumber(ARGV[4])
local request_hash = ARGV[5]
local ttl_seconds = tonumber(ARGV[6])

-- ------------------------------------------------------------------------------
-- 1. Idempotency Check
-- ------------------------------------------------------------------------------
local existing_hash = redis.call('HGET', idempotency_key, 'request_hash')
if existing_hash then
    local stored_res_id = redis.call('HGET', idempotency_key, 'reservation_id')
    local stored_status = redis.call('HGET', idempotency_key, 'status')
    if existing_hash == request_hash then
        -- Idempotent replay: return original reservation details
        return cjson.encode({
            success = true,
            status = "IDEMPOTENT_REPLAY",
            reservationId = stored_res_id,
            reservation_id = stored_res_id,
            requestStatus = stored_status or "HELD"
        })
    else
        -- Conflict: same key reused with differing parameters
        return cjson.encode({
            success = false,
            error = "IDEMPOTENCY_CONFLICT",
            message = "Idempotency key has already been used with a different request payload."
        })
    end
end

-- ------------------------------------------------------------------------------
-- 2. Validate Seat List
-- ------------------------------------------------------------------------------
local seat_count = #ARGV - 6
if seat_count <= 0 then
    return cjson.encode({
        success = false,
        error = "EMPTY_SEAT_SELECTION",
        message = "At least one seat must be selected."
    })
end

local requested_seats = {}
local seen_seats = {}
for i = 7, #ARGV do
    local seat_id = ARGV[i]
    if seen_seats[seat_id] then
        return cjson.encode({
            success = false,
            error = "DUPLICATE_SEAT_IN_REQUEST",
            seatId = seat_id,
            seat_id = seat_id,
            message = "Duplicate seat ID found in hold request."
        })
    end
    seen_seats[seat_id] = true
    table.insert(requested_seats, seat_id)
end

-- ------------------------------------------------------------------------------
-- 3. Pre-Flight Verification: Verify all seats exist & are AVAILABLE
-- Strict all-or-nothing guarantee: inspect every requested seat first.
-- If ANY seat is missing or not AVAILABLE, abort with NO changes made.
-- ------------------------------------------------------------------------------
for _, seat_id in ipairs(requested_seats) do
    local current_status = redis.call('HGET', seats_key, seat_id)
    if not current_status then
        return cjson.encode({
            success = false,
            error = "SEAT_NOT_FOUND",
            seatId = seat_id,
            seat_id = seat_id,
            message = "Seat does not exist in session inventory."
        })
    end
    if current_status ~= "AVAILABLE" then
        return cjson.encode({
            success = false,
            error = "SEAT_UNAVAILABLE",
            seatId = seat_id,
            seat_id = seat_id,
            currentStatus = current_status,
            current_status = current_status,
            message = "Seat is not available for hold."
        })
    end
end

-- ------------------------------------------------------------------------------
-- 4. Atomic Transition to HELD
-- ------------------------------------------------------------------------------
for _, seat_id in ipairs(requested_seats) do
    redis.call('HSET', seats_key, seat_id, "HELD")
    redis.call('SADD', res_seats_key, seat_id)
end

-- ------------------------------------------------------------------------------
-- 5. Record Reservation Metadata
-- ------------------------------------------------------------------------------
redis.call('HMSET', reservation_key,
    'id', reservation_id,
    'user_id', user_id,
    'status', 'HELD',
    'created_at', now_ms,
    'expires_at', expires_at_ms,
    'request_hash', request_hash,
    'seat_count', seat_count
)

-- Set expiration buffer on transient reservation metadata (TTL + 24 hours retention)
local buffer_ttl = ttl_seconds + 86400
redis.call('EXPIRE', reservation_key, buffer_ttl)
redis.call('EXPIRE', res_seats_key, buffer_ttl)

-- ------------------------------------------------------------------------------
-- 6. Register Expiration Index in Sorted Set
-- ------------------------------------------------------------------------------
redis.call('ZADD', expirations_key, expires_at_ms, reservation_id)

-- ------------------------------------------------------------------------------
-- 7. Record Idempotency Entry
-- ------------------------------------------------------------------------------
redis.call('HMSET', idempotency_key,
    'reservation_id', reservation_id,
    'request_hash', request_hash,
    'status', 'HELD',
    'created_at', now_ms
)
redis.call('EXPIRE', idempotency_key, buffer_ttl)

return cjson.encode({
    success = true,
    status = "SUCCESS",
    reservationId = reservation_id,
    reservation_id = reservation_id,
    expiresAt = expires_at_ms,
    expires_at = expires_at_ms,
    seats = requested_seats
})
