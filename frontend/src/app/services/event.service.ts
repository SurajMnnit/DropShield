import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable, map } from 'rxjs';
import type { EventModel, SessionModel, SessionSeatsResponse } from '@dropshield/shared';

@Injectable({
  providedIn: 'root',
})
export class EventService {
  private readonly http = inject(HttpClient);
  private readonly baseUrl = 'http://localhost:3000/api/v1';

  getEvents(params?: { page?: number; limit?: number; category?: string }): Observable<{
    events: EventModel[];
    pagination: { total: number; page: number; limit: number; totalPages: number };
  }> {
    let httpParams = new HttpParams();
    if (params?.page) httpParams = httpParams.set('page', params.page.toString());
    if (params?.limit) httpParams = httpParams.set('limit', params.limit.toString());
    if (params?.category) httpParams = httpParams.set('category', params.category);

    return this.http
      .get<{ success: boolean; data: { events: EventModel[]; pagination: any } }>(
        `${this.baseUrl}/events`,
        { params: httpParams }
      )
      .pipe(map((res) => res.data));
  }

  getEvent(id: string): Observable<{ event: EventModel; sessions: SessionModel[] }> {
    return this.http
      .get<{ success: boolean; data: { event: EventModel; sessions: SessionModel[] } }>(
        `${this.baseUrl}/events/${id}`
      )
      .pipe(map((res) => res.data));
  }

  getEventSessions(eventId: string): Observable<SessionModel[]> {
    return this.http
      .get<{ success: boolean; data: { sessions: SessionModel[] } }>(
        `${this.baseUrl}/events/${eventId}/sessions`
      )
      .pipe(map((res) => res.data.sessions));
  }

  getSession(sessionId: string): Observable<SessionModel> {
    return this.http
      .get<{ success: boolean; data: SessionModel }>(`${this.baseUrl}/sessions/${sessionId}`)
      .pipe(map((res) => res.data));
  }

  getSessionSeats(sessionId: string): Observable<SessionSeatsResponse> {
    return this.http
      .get<{ success: boolean; data: SessionSeatsResponse }>(
        `${this.baseUrl}/sessions/${sessionId}/seats`
      )
      .pipe(map((res) => res.data));
  }

  // Admin: Create Event
  createEvent(event: { title: string; description?: string; category: string }): Observable<any> {
    return this.http.post(`${this.baseUrl}/events`, event, { withCredentials: true });
  }

  // Admin: Create Session
  createSession(eventId: string, session: { venueId: string; startsAt: string; endsAt: string }): Observable<any> {
    return this.http.post(`${this.baseUrl}/events/${eventId}/sessions`, session, { withCredentials: true });
  }
}
