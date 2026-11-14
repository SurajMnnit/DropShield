# DropShield — Authentication, Payment Lifecycle & Frontend Architecture

## 1. Executive Summary

Phase 6 delivers an end-to-end user-facing ticketing experience for DropShield, integrating:
1. **Secure Authentication & RBAC**: JWT access tokens stored in secure, `HttpOnly` cookies, double-submit CSRF cookie mitigation, sliding-window rate limiting, and role enforcement (`buyer` and `admin`).
2. **Event & Session Discovery**: Fast paginated catalog queries merged dynamically with in-memory Redis inventory leases to show live, authoritative seat availability.
3. **Pluggable Payment Engine**: Strategy-pattern payment abstraction with HMAC-SHA256 webhook verification, transactional multi-table finalization, and strictly immutable financial ledger auditing.
4. **Modern Angular 19+ Frontend**: Reactive, standalone-component architecture using Angular Signals, Tailwind CSS, lazy-loaded route bundles, and interactive SVG/grid seating maps with lease countdown timers.

---

## 2. Authentication & Authorization Architecture

### 2.1 Credential Security & Password Hashing
- Passwords are validated for complexity (minimum 8 characters, at least 1 uppercase letter, at least 1 numeric digit) before hitting database storage.
- Passwords are salted and hashed using `bcryptjs` with 12 calculation rounds (`SALT_ROUNDS = 12`).
- Plaintext passwords never leave the client request boundary and are omitted from all logs and responses.

### 2.2 Token Storage & Session Mechanics
- **Access Token**: Stored in an `access_token` cookie configured with:
  - `httpOnly: true` (prevents XSS exfiltration via `document.cookie`)
  - `sameSite: 'lax'` (or `'strict'` in production)
  - `secure: true` in production (HTTPS-only)
  - Max age: 24 hours
- **Bearer Fallback**: For automated integration testing, the token is also returned in JSON response bodies and accepted via `Authorization: Bearer <token>`.
- **Identity Isolation**: User identity is strictly resolved from the verified JWT payload (`req.user = { id: decoded.sub, role: decoded.role }`). Request bodies and query parameters are never trusted for identity resolution.

### 2.3 Double-Submit CSRF Protection
- Upon login or registration, a cryptographically random CSRF token (`XSRF-TOKEN`) is issued in a client-readable cookie.
- For all state-mutating HTTP operations (`POST`, `PUT`, `DELETE`, `PATCH`) authenticated via cookies, the client must echo this token in the `x-csrf-token` request header.
- The `requireAuth` middleware verifies that the header token matches the signed token embedded in the user's active session, preventing Cross-Site Request Forgery.

### 2.4 Rate Limiting
- An in-memory sliding-window rate limiter protects sensitive endpoints (`/api/v1/auth/register` and `/api/v1/auth/login`) with a maximum quota of 20 attempts per 15-minute window per IP.

---

## 3. Live Seat Inventory & Discovery

### 3.1 Relational & Cache Synthesis
To present real-time seat states without overselling or stale cache hazards, `GET /api/v1/sessions/:sessionId/seats` executes a hybrid merge:
1. Queries durable physical venue seats and session pricing from PostgreSQL (`session_seats` joined with `venue_seats`).
2. Concurrently fetches the active session inventory hash from Redis (`HGETALL dropshield:session:{sessionId}:seats`).
3. Merges the states:
   - If PostgreSQL marks the seat as `BOOKED`, the state is permanently `BOOKED`.
   - If Redis contains an active lease (`HELD`), the seat dynamically renders as `HELD` with active lease duration.
   - Otherwise, the seat renders as `AVAILABLE`.

### 3.2 Visual Seat Map
The interactive `<app-seat-map>` component groups seats by Section (e.g., VIP, Balcony, General) and Row (A, B, C...):
- **Available**: Selectable (emerald accent), up to 10 seats per booking.
- **Selected**: Highlighted with teal glow and reactive price accumulation.
- **Held**: Amber badge indicating another user currently holds a temporary reservation lease.
- **Booked**: Disabled, crossed out.

---

## 4. Payment Lifecycle & Financial Ledger Immutability

```
[ User Holds Seats ]
         │
         ▼
[ POST /sessions/:id/reservations ] ──(Atomic Redis Lua Hold)──► Status: PENDING (10m TTL)
         │
         ▼
[ POST /reservations/:id/payments ] ──► Initialize Intent via PaymentProvider
         │
         ▼
[ Webhook / Provider Confirmation ] ──► Verify HMAC-SHA256 Signature
         │
         ├───► Valid Signature:
         │        │
         │        ├── 1. INSERT INTO bookings (CONFIRMED)
         │        ├── 2. INSERT INTO booking_items (Seat Snapshots)
         │        ├── 3. INSERT INTO payments (SUCCEEDED)
         │        ├── 4. UPDATE reservations SET status = 'CONFIRMED'
         │        ├── 5. UPDATE session_seats SET status = 'BOOKED'
         │        ├── 6. INSERT INTO transaction_ledger (CHARGE)
         │        └── 7. Redis: confirmSeats (State = BOOKED)
         │
         └───► Failed Payment / Rejection:
                  │
                  ├── 1. UPDATE reservations SET status = 'FAILED'
                  ├── 2. Redis: releaseSeats (State = AVAILABLE)
                  └── 3. session_seats released
```

### 4.1 Payment Provider Strategy Pattern
Payment handling is abstracted behind a typed interface (`PaymentProvider`):
- `createPayment(params)`
- `verifyWebhook(params)`
- `processRefund(params)`

The implementation `DevPaymentProvider` signs and validates payloads with HMAC-SHA256 signatures (`x-dropshield-signature`).

### 4.2 Database Transaction & Ledger Guarantees
- Multi-table writes run inside a single PostgreSQL ACID transaction (`BEGIN ... COMMIT`).
- Database foreign key constraints enforce that `payments` must reference an existing `bookings` row, ensuring booking items and bookings are durably inserted before payments.
- **Financial Audit Trail**: All charges and refunds append records to `transaction_ledger`. Triggers installed in Phase 3 strictly forbid `UPDATE`, `DELETE`, or `TRUNCATE` operations on this table, guaranteeing tamper-proof accounting.

---

## 5. Angular 19 Frontend Implementation

### 5.1 Architecture & Design System
- **Standalone Components**: 100% standalone components without legacy `NgModule`.
- **Angular Signals**: Signals and computed signals drive reactive state (`currentUser`, `selectedSeatIds`, `totalPriceMinor`, `secondsRemaining`).
- **Tailwind CSS**: Dark-themed, high-contrast, modern UI featuring glowing accents, glassmorphic cards, and responsive navigation.

### 5.2 Application Route Hierarchy
| Route | Component | Description |
|---|---|---|
| `/events` | `EventsComponent` | Public event discovery with category filters & search |
| `/events/:id` | `EventDetailComponent` | Event overview, description, and session schedule |
| `/booking/:sessionId` | `BookingComponent` | Interactive visual seat map & selection engine |
| `/checkout/:reservationId` | `CheckoutComponent` | Hold summary, live expiration countdown timer & payment |
| `/confirmation/:bookingId` | `ConfirmationComponent` | Digital ticket voucher, seat breakdown & refund trigger |
| `/bookings` | `BookingHistoryComponent` | User's historical and upcoming confirmed bookings |
| `/login` | `LoginComponent` | Secure user authentication |
| `/register` | `RegisterComponent` | Registration with password strength indicators |
| `/admin` | `AdminComponent` | Event creation and session scheduling operations |

---

## 6. Verification & Quality Assurance

All features are covered by automated integration tests:
- `backend/tests/auth.test.ts`: Registration, password validation, duplicate email rejection, cookie setting, CSRF validation, session invalidation.
- `backend/tests/events.test.ts`: Event catalog discovery, pagination, category filtering, session retrieval, real-time Redis seat status synthesis.
- `backend/tests/payment.test.ts`: Payment initialization, HMAC signature verification, atomic booking creation, immutable ledger insertion, payment failure rollback, and refunds.
- **Suite Result**: 12/12 Test Suites Passed, 89/89 Tests Passed.
- **Build Status**: Angular and TypeScript production builds complete with zero compiler errors.
