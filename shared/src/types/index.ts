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
