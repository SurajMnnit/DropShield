import { Component, Input, OnInit, OnDestroy, inject, signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router, RouterLink } from '@angular/router';
import { BookingService, ReservationDetails } from '../../services/booking.service.js';
import { PaymentService } from '../../services/payment.service.js';

@Component({
  selector: 'app-checkout',
  standalone: true,
  imports: [CommonModule, RouterLink],
  template: `
    <div class="max-w-2xl mx-auto px-4 sm:px-6 lg:px-8 py-10">
      <!-- Back Link -->
      <a routerLink="/events" class="inline-flex items-center text-xs font-semibold text-slate-400 hover:text-teal-400 transition mb-6">
        <span class="mr-1">←</span> Cancel & Back to Events
      </a>

      @if (isLoading()) {
        <div class="py-24 text-center text-slate-400">
          <div class="inline-block w-8 h-8 border-2 border-teal-400 border-t-transparent rounded-full animate-spin mb-3"></div>
          <div>Loading reservation hold details...</div>
        </div>
      } @else if (reservation()) {
        <!-- Expiration Alert Banner -->
        <div
          [ngClass]="secondsRemaining() <= 60 ? 'bg-red-950/40 border-red-800 text-red-300' : 'bg-amber-950/30 border-amber-800/80 text-amber-300'"
          class="p-4 rounded-2xl border mb-6 flex items-center justify-between shadow-lg"
        >
          <div class="flex items-center space-x-3">
            <span class="text-xl">⏱️</span>
            <div>
              <div class="text-xs font-semibold uppercase tracking-wider">Temporary Seat Lease Active</div>
              <div class="text-xs opacity-90">Seats are locked in Redis. Complete payment before the lease expires.</div>
            </div>
          </div>
          <div class="font-mono text-lg font-bold px-3 py-1 rounded-lg bg-black/40 border border-current">
            {{ formatTime(secondsRemaining()) }}
          </div>
        </div>

        @if (isExpired()) {
          <div class="bg-red-950/50 border border-red-800 rounded-3xl p-8 text-center text-red-300 shadow-xl mb-6">
            <div class="text-4xl mb-3">⌛</div>
            <h2 class="text-xl font-bold text-white mb-2">Reservation Lease Expired</h2>
            <p class="text-xs text-red-400 mb-6">
              Your temporary lock lease has ended and the seats have been automatically released back to the global inventory pool.
            </p>
            <a
              routerLink="/events"
              class="inline-flex items-center px-6 py-2.5 rounded-xl text-xs font-bold bg-slate-800 hover:bg-slate-700 text-white transition border border-slate-700"
            >
              Browse Available Events
            </a>
          </div>
        } @else {
          <!-- Checkout Card -->
          <div class="bg-slate-900 border border-slate-800 rounded-3xl p-8 shadow-2xl space-y-6">
            <div class="border-b border-slate-800 pb-5">
              <span class="text-xs text-teal-400 font-semibold uppercase tracking-wider">Checkout & Payment</span>
              <h1 class="text-2xl font-extrabold text-white mt-1">Review Reservation</h1>
              <p class="text-xs text-slate-400 mt-1 font-mono">
                Reservation Reference: {{ reservation()?.reservationId }}
              </p>
            </div>

            <!-- Price Breakdown -->
            <div class="bg-slate-950/60 rounded-2xl p-5 border border-slate-800/80 space-y-3">
              <div class="flex justify-between text-xs text-slate-400">
                <span>Hold Lease Duration</span>
                <span>10 Minutes</span>
              </div>
              <div class="flex justify-between text-xs text-slate-400">
                <span>Status</span>
                <span class="text-teal-400 font-semibold uppercase">{{ reservation()?.status }}</span>
              </div>
              <div class="pt-3 border-t border-slate-800 flex justify-between items-baseline">
                <span class="text-sm font-semibold text-slate-200">Total Payable Amount</span>
                <span class="text-2xl font-bold text-teal-400 font-mono">
                  ₹{{ formatPrice(reservation()?.totalAmountMinor || 0) }}
                </span>
              </div>
            </div>

            <!-- Payment Methods -->
            <div class="space-y-3">
              <label class="block text-xs font-semibold text-slate-300 uppercase tracking-wider">
                Select Payment Method
              </label>
              <div class="p-4 rounded-xl border border-teal-500/40 bg-teal-500/5 flex items-center justify-between">
                <div class="flex items-center space-x-3">
                  <span class="text-xl">💳</span>
                  <div>
                    <div class="text-sm font-bold text-white">DropShield Direct / Simulated Gateway</div>
                    <div class="text-xs text-slate-400">Instant test payment with HMAC webhook verification</div>
                  </div>
                </div>
                <span class="w-3 h-3 rounded-full bg-teal-400"></span>
              </div>
            </div>

            <!-- Pay Button -->
            <button
              type="button"
              (click)="onPay()"
              [disabled]="isPaying() || isExpired()"
              class="w-full py-3.5 px-6 rounded-xl text-sm font-bold bg-teal-500 hover:bg-teal-400 text-slate-950 transition shadow-lg shadow-teal-500/20 disabled:opacity-50 flex items-center justify-center space-x-2"
            >
              @if (isPaying()) {
                <span class="w-4 h-4 border-2 border-slate-950 border-t-transparent rounded-full animate-spin"></span>
                <span>Processing Payment...</span>
              } @else {
                <span>Pay ₹{{ formatPrice(reservation()?.totalAmountMinor || 0) }} & Confirm</span>
              }
            </button>
          </div>
        }
      }
    </div>
  `,
})
export class CheckoutComponent implements OnInit, OnDestroy {
  @Input({ required: true }) reservationId!: string;

  private readonly bookingService = inject(BookingService);
  private readonly paymentService = inject(PaymentService);
  private readonly router = inject(Router);

  readonly reservation = signal<ReservationDetails | null>(null);
  readonly isLoading = signal<boolean>(true);
  readonly isPaying = signal<boolean>(false);
  readonly secondsRemaining = signal<number>(600);

  private timerInterval: any = null;

  readonly isExpired = computed(() => this.secondsRemaining() <= 0);

  ngOnInit(): void {
    if (this.reservationId) {
      this.loadReservation();
    }
  }

  ngOnDestroy(): void {
    if (this.timerInterval) {
      clearInterval(this.timerInterval);
    }
  }

  loadReservation(): void {
    this.isLoading.set(true);
    this.bookingService.getReservation(this.reservationId).subscribe({
      next: (data) => {
        this.reservation.set(data);
        this.isLoading.set(false);

        // Compute lease timer
        const expiryTime = new Date(data.expiresAt).getTime();
        this.updateRemainingSeconds(expiryTime);

        this.timerInterval = setInterval(() => {
          this.updateRemainingSeconds(expiryTime);
        }, 1000);
      },
      error: () => {
        this.isLoading.set(false);
      },
    });
  }

  private updateRemainingSeconds(expiryTime: number): void {
    const diff = Math.max(0, Math.floor((expiryTime - Date.now()) / 1000));
    this.secondsRemaining.set(diff);
    if (diff <= 0 && this.timerInterval) {
      clearInterval(this.timerInterval);
    }
  }

  formatTime(totalSeconds: number): string {
    const mins = Math.floor(totalSeconds / 60);
    const secs = totalSeconds % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }

  formatPrice(minor: number): string {
    return (minor / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 });
  }

  onPay(): void {
    if (this.isPaying() || this.isExpired()) return;

    this.isPaying.set(true);
    this.paymentService.initializePayment(this.reservationId, true).subscribe({
      next: (res) => {
        this.isPaying.set(false);
        const bookingId = res.bookingId;
        if (bookingId) {
          this.router.navigate(['/confirmation', bookingId]);
        } else {
          // Poll reservation to find bookingId
          this.bookingService.getReservation(this.reservationId).subscribe((resDetails) => {
            if (resDetails.bookingId) {
              this.router.navigate(['/confirmation', resDetails.bookingId]);
            } else {
              this.router.navigate(['/bookings']);
            }
          });
        }
      },
      error: () => {
        this.isPaying.set(false);
      },
    });
  }
}
