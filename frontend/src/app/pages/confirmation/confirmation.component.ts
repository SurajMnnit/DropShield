import { Component, Input, OnInit, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterLink } from '@angular/router';
import { BookingService } from '../../services/booking.service.js';
import type { Booking } from '@dropshield/shared';

@Component({
  selector: 'app-confirmation',
  standalone: true,
  imports: [CommonModule, RouterLink],
  template: `
    <div class="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-10">
      @if (isLoading()) {
        <div class="py-24 text-center text-slate-400">
          <div class="inline-block w-8 h-8 border-2 border-teal-400 border-t-transparent rounded-full animate-spin mb-3"></div>
          <div>Loading booking confirmation...</div>
        </div>
      } @else if (booking()) {
        <!-- Success Banner -->
        @if (booking()?.status === 'CONFIRMED') {
          <div class="bg-gradient-to-r from-emerald-950/40 via-slate-900 to-teal-950/40 border border-emerald-500/30 rounded-3xl p-8 mb-8 text-center shadow-2xl">
            <div class="w-16 h-16 rounded-full bg-emerald-500/20 border border-emerald-500/40 flex items-center justify-center text-3xl text-emerald-400 mx-auto mb-4 shadow-lg shadow-emerald-500/10">
              ✓
            </div>
            <h1 class="text-3xl font-extrabold text-white mb-2">Booking Confirmed!</h1>
            <p class="text-xs md:text-sm text-slate-300 max-w-md mx-auto">
              Your seats are permanently booked and an immutable record has been committed to the financial ledger.
            </p>
          </div>
        } @else if (booking()?.status === 'REFUNDED') {
          <div class="bg-amber-950/40 border border-amber-800 rounded-3xl p-8 mb-8 text-center shadow-xl">
            <div class="w-16 h-16 rounded-full bg-amber-500/20 border border-amber-500/40 flex items-center justify-center text-3xl text-amber-400 mx-auto mb-4">
              ↺
            </div>
            <h1 class="text-3xl font-extrabold text-white mb-2">Booking Refunded</h1>
            <p class="text-xs md:text-sm text-slate-300 max-w-md mx-auto">
              This ticket has been refunded and an immutable REFUND entry was appended to the transaction ledger.
            </p>
          </div>
        }

        <!-- Ticket Card -->
        <div class="bg-slate-900 border border-slate-800 rounded-3xl overflow-hidden shadow-2xl mb-8">
          <div class="p-8 border-b border-slate-800 bg-slate-950/40">
            <div class="flex flex-wrap items-center justify-between gap-4">
              <div>
                <span class="text-xs font-semibold text-teal-400 uppercase tracking-wider">Confirmed Ticket Pass</span>
                <h2 class="text-2xl font-bold text-white mt-1">{{ booking()?.event?.title }}</h2>
              </div>
              <div class="text-right">
                <span
                  [ngClass]="booking()?.status === 'CONFIRMED' ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' : 'bg-amber-500/10 text-amber-400 border-amber-500/20'"
                  class="px-3 py-1 rounded-full text-xs font-bold border"
                >
                  {{ booking()?.status }}
                </span>
                <div class="text-[11px] text-slate-500 font-mono mt-1">
                  ID: {{ booking()?.id?.slice(0, 8) }}
                </div>
              </div>
            </div>
          </div>

          <div class="p-8 space-y-6">
            <!-- Event & Venue Specs -->
            <div class="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
              <div class="p-4 rounded-xl bg-slate-950/60 border border-slate-800">
                <div class="text-slate-400 mb-1">Session Date & Time</div>
                <div class="font-bold text-white text-sm">
                  {{ formatDate(booking()?.session?.startsAt || '') }}
                </div>
              </div>

              <div class="p-4 rounded-xl bg-slate-950/60 border border-slate-800">
                <div class="text-slate-400 mb-1">Venue Location</div>
                <div class="font-bold text-white text-sm">
                  {{ booking()?.session?.venueName }}
                </div>
                <div class="text-slate-400 mt-0.5">
                  {{ booking()?.session?.venueAddress }}, {{ booking()?.session?.venueCity }}
                </div>
              </div>
            </div>

            <!-- Seat Breakdown -->
            <div>
              <h3 class="text-xs font-bold text-slate-300 uppercase tracking-wider mb-3">Your Seats</h3>
              <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
                @for (item of booking()?.items; track item.id) {
                  <div class="p-3.5 rounded-xl bg-slate-950/60 border border-slate-800 flex items-center justify-between">
                    <div>
                      <div class="font-bold text-white text-sm">
                        {{ item.section }} • Row {{ item.rowLabel }}, Seat {{ item.seatNumber }}
                      </div>
                      <div class="text-[11px] text-slate-400 capitalize">{{ item.seatType }}</div>
                    </div>
                    <div class="font-mono text-xs font-semibold text-teal-400">
                      ₹{{ formatPrice(item.unitPriceMinor) }}
                    </div>
                  </div>
                }
              </div>
            </div>

            <!-- Payment Summary -->
            <div class="pt-5 border-t border-slate-800 flex justify-between items-baseline">
              <span class="text-sm font-semibold text-slate-300">Total Paid (INR)</span>
              <span class="text-2xl font-bold text-teal-400 font-mono">
                ₹{{ formatPrice(booking()?.totalAmountMinor || 0) }}
              </span>
            </div>
          </div>
        </div>

        <!-- Action Buttons -->
        <div class="flex flex-wrap items-center justify-between gap-4">
          <a
            routerLink="/bookings"
            class="px-5 py-2.5 rounded-xl text-xs font-semibold bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 transition"
          >
            ← View All Bookings
          </a>

          @if (booking()?.status === 'CONFIRMED') {
            <button
              (click)="onRefund()"
              [disabled]="isRefunding()"
              class="px-5 py-2.5 rounded-xl text-xs font-bold bg-red-950/40 hover:bg-red-900/60 text-red-300 border border-red-800 transition disabled:opacity-50"
            >
              @if (isRefunding()) {
                <span>Processing Refund...</span>
              } @else {
                <span>Request Booking Refund</span>
              }
            </button>
          }
        </div>
      }
    </div>
  `,
})
export class ConfirmationComponent implements OnInit {
  @Input({ required: true }) bookingId!: string;

  private readonly bookingService = inject(BookingService);

  readonly booking = signal<Booking | null>(null);
  readonly isLoading = signal<boolean>(true);
  readonly isRefunding = signal<boolean>(false);

  ngOnInit(): void {
    if (this.bookingId) {
      this.loadBooking();
    }
  }

  loadBooking(): void {
    this.isLoading.set(true);
    this.bookingService.getBooking(this.bookingId).subscribe({
      next: (data) => {
        this.booking.set(data);
        this.isLoading.set(false);
      },
      error: () => {
        this.isLoading.set(false);
      },
    });
  }

  formatDate(dateStr: string): string {
    if (!dateStr) return '';
    return new Date(dateStr).toLocaleString('en-US', {
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

  onRefund(): void {
    if (confirm('Are you sure you want to cancel this booking and initiate a full refund?')) {
      this.isRefunding.set(true);
      this.bookingService.refundBooking(this.bookingId, 'Customer cancellation').subscribe({
        next: () => {
          this.isRefunding.set(false);
          this.loadBooking();
        },
        error: () => {
          this.isRefunding.set(false);
        },
      });
    }
  }
}
