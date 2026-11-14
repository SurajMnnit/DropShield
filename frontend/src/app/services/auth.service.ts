import { Injectable, inject, signal, computed } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Observable, tap, catchError, of, throwError, map } from 'rxjs';
import type { User, AuthResponse } from '@dropshield/shared';

@Injectable({
  providedIn: 'root',
})
export class AuthService {
  private readonly http = inject(HttpClient);
  private readonly baseUrl = 'http://localhost:3000/api/v1/auth';

  readonly currentUser = signal<User | null>(null);
  readonly isLoading = signal<boolean>(false);
  readonly csrfToken = signal<string | null>(null);

  readonly isLoggedIn = computed(() => this.currentUser() !== null);
  readonly isAdmin = computed(() => this.currentUser()?.role === 'admin');

  constructor() {
    this.extractCsrfFromCookie();
    this.checkAuth().subscribe();
  }

  private extractCsrfFromCookie(): void {
    if (typeof document !== 'undefined') {
      const match = document.cookie.match(/(?:^|;\s*)XSRF-TOKEN=([^;]*)/);
      if (match && match[1]) {
        this.csrfToken.set(decodeURIComponent(match[1]));
      }
    }
  }

  getCsrfHeaders(): HttpHeaders {
    let headers = new HttpHeaders();
    const token = this.csrfToken();
    if (token) {
      headers = headers.set('x-csrf-token', token);
    }
    return headers;
  }

  register(data: { name: string; email: string; password: string; role?: 'buyer' | 'admin' }): Observable<any> {
    this.isLoading.set(true);
    return this.http
      .post<{ success: boolean; data: AuthResponse }>(`${this.baseUrl}/register`, data, {
        withCredentials: true,
      })
      .pipe(
        tap((res) => {
          this.isLoading.set(false);
          if (res.success && res.data) {
            this.currentUser.set(res.data.user);
            if (res.data.csrfToken) {
              this.csrfToken.set(res.data.csrfToken);
            }
          }
        }),
        catchError((err) => {
          this.isLoading.set(false);
          return throwError(() => err);
        })
      );
  }

  login(credentials: { email: string; password: string }): Observable<any> {
    this.isLoading.set(true);
    return this.http
      .post<{ success: boolean; data: AuthResponse }>(`${this.baseUrl}/login`, credentials, {
        withCredentials: true,
      })
      .pipe(
        tap((res) => {
          this.isLoading.set(false);
          if (res.success && res.data) {
            this.currentUser.set(res.data.user);
            if (res.data.csrfToken) {
              this.csrfToken.set(res.data.csrfToken);
            }
          }
        }),
        catchError((err) => {
          this.isLoading.set(false);
          return throwError(() => err);
        })
      );
  }

  logout(): Observable<any> {
    const headers = this.getCsrfHeaders();
    return this.http
      .post(`${this.baseUrl}/logout`, {}, {
        headers,
        withCredentials: true,
      })
      .pipe(
        tap(() => {
          this.currentUser.set(null);
          this.csrfToken.set(null);
        }),
        catchError(() => {
          this.currentUser.set(null);
          return of({ success: true });
        })
      );
  }

  checkAuth(): Observable<User | null> {
    return this.http
      .get<{ success: boolean; data: { user: User } }>(`${this.baseUrl}/me`, {
        withCredentials: true,
      })
      .pipe(
        map((res) => {
          if (res.success && res.data?.user) {
            this.currentUser.set(res.data.user);
            this.extractCsrfFromCookie();
            return res.data.user;
          }
          return null;
        }),
        catchError(() => {
          this.currentUser.set(null);
          return of(null);
        })
      );
  }
}
