import { Component, OnInit, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterLink } from '@angular/router';
import { BookingService } from '../../services/booking.service.js';
import type { Booking } from '@dropshield/shared';

@Component({
  selector: 'app-booking-history',
  standalone: true,
  imports: [CommonModule, RouterLink],
  template: `
    <div class="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-10">
      <div class="border-b border-slate-800 pb-5 mb-8 flex items-center justify-between">
        <div>
          <h1 class="text-3xl font-bold text-white">My Booking History</h1>
          <p class="text-xs text-slate-400 mt-1">
            Authoritative transactional tickets confirmed in PostgreSQL and backed by immutable ledger audit records.
          </p>
        </div>
        <button
          (click)="loadBookings()"
          [disabled]="isLoading()"
          class="px-3 py-1.5 rounded-lg text-xs bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 transition"
        >
          🔄 Refresh
        </button>
      </div>

      @if (isLoading()) {
        <div class="py-24 text-center text-slate-400">
          <div class="inline-block w-8 h-8 border-2 border-teal-400 border-t-transparent rounded-full animate-spin mb-3"></div>
          <div>Loading your booking records...</div>
        </div>
      } @else if (bookings().length === 0) {
        <div class="bg-slate-900 border border-slate-800 rounded-3xl p-12 text-center text-slate-400 shadow-xl">
          <div class="text-4xl mb-3">🎟️</div>
          <h3 class="text-lg font-bold text-white mb-1">No Bookings Yet</h3>
          <p class="text-xs text-slate-400 max-w-sm mx-auto mb-6">
            You have not made any ticket reservations yet. Browse our live events to book seats.
          </p>
          <a
            routerLink="/events"
            class="inline-flex items-center px-6 py-2.5 rounded-xl text-xs font-bold bg-teal-500 hover:bg-teal-400 text-slate-950 transition shadow-lg shadow-teal-500/20"
          >
            Explore Events
          </a>
        </div>
      } @else {
        <div class="space-y-4">
          @for (booking of bookings(); track booking.id) {
            <div class="bg-slate-900 border border-slate-800 hover:border-slate-700 rounded-2xl p-6 transition flex flex-col md:flex-row md:items-center justify-between gap-6 shadow-lg">
              <div class="space-y-2">
                <div class="flex items-center space-x-3">
                  <span class="text-lg font-bold text-white">
                    {{ booking.event.title || 'Live Event' }}
                  </span>
                  <span
                    [ngClass]="booking.status === 'CONFIRMED' ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' : 'bg-amber-500/10 text-amber-400 border-amber-500/20'"
                    class="px-2.5 py-0.5 rounded-full text-[10px] font-bold border tracking-wider uppercase"
                  >
                    {{ booking.status }}
                  </span>
                </div>

                <div class="text-xs text-slate-400 flex flex-wrap items-center gap-3">
                  <span>📍 {{ booking.event.venueName || 'Main Arena' }}</span>
                  <span>•</span>
                  <span>Starts: {{ formatDate(booking.event.startsAt || booking.confirmedAt) }}</span>
                  <span>•</span>
                  <span class="text-slate-300 font-medium">{{ booking.itemCount || 1 }} Ticket(s)</span>
                </div>

                <div class="text-[11px] text-slate-500 font-mono">
                  Booking ID: {{ booking.id }}
                </div>
              </div>

              <div class="flex items-center space-x-4 border-t md:border-t-0 pt-4 md:pt-0 border-slate-800 justify-between md:justify-end">
                <div class="text-right">
                  <div class="text-[11px] text-slate-500 uppercase">Paid Amount</div>
                  <div class="text-base font-bold text-teal-400 font-mono">
                    ₹{{ formatPrice(booking.totalAmountMinor) }}
                  </div>
                </div>

                <a
                  [routerLink]="['/confirmation', booking.id]"
                  class="px-4 py-2 rounded-xl text-xs font-bold bg-slate-800 hover:bg-slate-700 text-white border border-slate-700 transition"
                >
                  View Ticket Pass →
                </a>
              </div>
            </div>
          }
        </div>
      }
    </div>
  `,
})
export class BookingHistoryComponent implements OnInit {
  private readonly bookingService = inject(BookingService);

  readonly bookings = signal<Booking[]>([]);
  readonly isLoading = signal<boolean>(true);

  ngOnInit(): void {
    this.loadBookings();
  }

  loadBookings(): void {
    this.isLoading.set(true);
    this.bookingService.getBookings().subscribe({
      next: (data) => {
        this.bookings.set(data || []);
        this.isLoading.set(false);
      },
      error: () => {
        this.isLoading.set(false);
      },
    });
  }

  formatDate(dateStr: string): string {
    if (!dateStr) return '';
    return new Date(dateStr).toLocaleDateString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  formatPrice(minor: number): string {
    return (minor / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 });
  }
}
