import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Observable, map } from 'rxjs';
import type { Booking } from '@dropshield/shared';
import { AuthService } from './auth.service.js';

export interface ReservationHoldResult {
  reservationId: string;
  status: string;
  sessionId: string;
  seatIds: string[];
  expiresAt: string;
  acceptedAt: string;
  statusUrl: string;
}

export interface ReservationDetails {
  reservationId: string;
  sessionId: string;
  userId: string;
  status: string;
  expiresAt: string;
  totalAmountMinor: number;
  currency: string;
  bookingId?: string | null;
  bookingStatus?: string | null;
  confirmedAt?: string | null;
}

@Injectable({
  providedIn: 'root',
})
export class BookingService {
  private readonly http = inject(HttpClient);
  private readonly authService = inject(AuthService);
  private readonly baseUrl = 'http://localhost:3000/api/v1';

  createReservation(
    sessionId: string,
    seatIds: string[],
    idempotencyKey?: string
  ): Observable<ReservationHoldResult> {
    const key = idempotencyKey || `key_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    let headers = this.authService.getCsrfHeaders();
    headers = headers.set('x-idempotency-key', key);

    return this.http
      .post<{ success: boolean; data: ReservationHoldResult }>(
        `${this.baseUrl}/sessions/${sessionId}/reservations`,
        { seatIds, idempotencyKey: key },
        { headers, withCredentials: true }
      )
      .pipe(map((res) => res.data));
  }

  getReservation(reservationId: string): Observable<ReservationDetails> {
    return this.http
      .get<{ success: boolean; data: ReservationDetails }>(
        `${this.baseUrl}/reservations/${reservationId}`,
        { withCredentials: true }
      )
      .pipe(map((res) => res.data));
  }

  getBookings(): Observable<Booking[]> {
    return this.http
      .get<{ success: boolean; data: Booking[] }>(`${this.baseUrl}/bookings`, {
        withCredentials: true,
      })
      .pipe(map((res) => res.data));
  }

  getBooking(bookingId: string): Observable<Booking> {
    return this.http
      .get<{ success: boolean; data: Booking }>(`${this.baseUrl}/bookings/${bookingId}`, {
        withCredentials: true,
      })
      .pipe(map((res) => res.data));
  }

  refundBooking(bookingId: string, reason?: string): Observable<any> {
    const headers = this.authService.getCsrfHeaders();
    return this.http
      .post<{ success: boolean; data: any }>(
        `${this.baseUrl}/bookings/${bookingId}/refund`,
        { reason },
        { headers, withCredentials: true }
      )
      .pipe(map((res) => res.data));
  }
}
