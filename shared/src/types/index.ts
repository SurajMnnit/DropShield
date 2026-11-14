/**
 * DropShield Domain and API Types
 */

export type Environment = 'development' | 'production' | 'test' | 'staging' | 'alpha' | string;

export interface HealthResponse {
  status: 'healthy' | 'degraded' | 'down';
  uptime: number;
  timestamp: string;
  environment: Environment;
  version: string;
  services?: {
    database?: 'up' | 'down' | 'unreachable';
    redis?: 'up' | 'down' | 'unreachable';
    rabbitmq?: 'up' | 'down' | 'unreachable';
  };
}

export type ReservationStatus = 
  | 'PENDING'
  | 'RESERVED'
  | 'CONFIRMED'
  | 'EXPIRED'
  | 'FAILED'
  | 'CANCELLED';

export interface TicketTier {
  id: string;
  eventId: string;
  name: string;
  priceInCents: number;
  totalCapacity: number;
  availableCapacity: number;
}

export interface EventSummary {
  id: string;
  title: string;
  venue: string;
  date: string;
  tiers: TicketTier[];
}

export interface ReservationRequest {
  idempotencyKey: string;
  userId: string;
  eventId: string;
  tierId: string;
  ticketQuantity: number;
}

export interface ReservationResponse {
  reservationId: string;
  status: ReservationStatus;
  expiresAt: string;
  message?: string;
}

export interface BookingRequestedEventPayload {
  reservationId: string;
  sessionId: string;
  userId: string;
  seatIds: string[];
  idempotencyKey: string;
  expiresAt: string;
  totalAmountMinor: number;
  currency: string;
}

export interface BookingRequestedEvent {
  eventId: string;
  eventType: 'booking.requested';
  version: 'v1';
  timestamp: string;
  payload: BookingRequestedEventPayload;
  retryCount?: number;
}

// =============================================================================
// Phase 6: Auth, Events, Seat Maps, Payments & Bookings
// =============================================================================

export type UserRole = 'buyer' | 'admin';

export interface User {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  createdAt?: string;
}

export interface AuthTokens {
  accessToken: string;
  csrfToken: string;
}

export interface AuthResponse {
  user: User;
  csrfToken: string;
  token?: string;
}

export interface EventModel {
  id: string;
  title: string;
  description?: string;
  category: string;
  status: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED' | 'CANCELLED';
  createdAt: string;
  sessionsCount?: number;
}

export interface SessionModel {
  id: string;
  eventId: string;
  venueId: string;
  startsAt: string;
  endsAt: string;
  status: 'SCHEDULED' | 'OPEN' | 'COMPLETED' | 'CANCELLED' | 'POSTPONED';
  eventTitle?: string;
  eventCategory?: string;
  venueName?: string;
  venueAddress?: string;
  venueCity?: string;
  venueState?: string;
}

export type SeatState = 'AVAILABLE' | 'HELD' | 'BOOKED';

export interface SeatModel {
  id: string;
  section: string;
  rowLabel: string;
  seatNumber: string;
  seatType: string;
  priceMinor: number;
  status: SeatState;
  holdExpiresAt?: string | null;
}

export interface SessionSeatsResponse {
  sessionId: string;
  eventTitle: string;
  venueName: string;
  seats: SeatModel[];
  summary: {
    total: number;
    available: number;
    held: number;
    booked: number;
  };
}

export interface PaymentIntent {
  paymentId: string;
  providerPaymentId: string;
  bookingId?: string;
  clientSecret?: string;
  checkoutUrl?: string;
  amountMinor: number;
  currency: string;
  status: 'PENDING' | 'SUCCEEDED' | 'FAILED';
}

export interface BookingItem {
  id: string;
  sessionSeatId: string;
  unitPriceMinor: number;
  section: string;
  rowLabel: string;
  seatNumber: string;
  seatType: string;
}

export interface Booking {
  id: string;
  reservationId: string;
  userId: string;
  status: 'CONFIRMED' | 'CANCELLED' | 'REFUNDED';
  totalAmountMinor: number;
  currency: string;
  confirmedAt: string;
  createdAt: string;
  itemCount?: number;
  event: {
    id: string;
    title: string;
    description?: string;
    startsAt?: string;
    endsAt?: string;
    venueName?: string;
    venueAddress?: string;
    venueCity?: string;
  };
  session?: {
    id: string;
    startsAt: string;
    endsAt: string;
    venueName: string;
    venueAddress: string;
    venueCity: string;
  };
  items?: BookingItem[];
  payment?: {
    id: string;
    provider: string;
    providerPaymentId: string;
    status: string;
    amountMinor: number;
    currency: string;
    createdAt: string;
  } | null;
}
