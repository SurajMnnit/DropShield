import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, map } from 'rxjs';
import type { PaymentIntent } from '@dropshield/shared';
import { AuthService } from './auth.service.js';

@Injectable({
  providedIn: 'root',
})
export class PaymentService {
  private readonly http = inject(HttpClient);
  private readonly authService = inject(AuthService);
  private readonly baseUrl = 'http://localhost:3000/api/v1';

  initializePayment(reservationId: string, simulateSuccess = true): Observable<PaymentIntent> {
    const headers = this.authService.getCsrfHeaders();
    return this.http
      .post<{ success: boolean; data: PaymentIntent }>(
        `${this.baseUrl}/reservations/${reservationId}/payments`,
        { simulateSuccess },
        { headers, withCredentials: true }
      )
      .pipe(map((res) => res.data));
  }

  simulateWebhook(payload: any, signature: string): Observable<any> {
    return this.http.post(`${this.baseUrl}/payments/webhook`, payload, {
      headers: {
        'x-dropshield-signature': signature,
      },
    });
  }
}
