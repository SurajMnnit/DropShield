import { Component, Input, OnInit, inject, signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { EventService } from '../../services/event.service.js';
import { BookingService } from '../../services/booking.service.js';
import { AuthService } from '../../services/auth.service.js';
import type { SeatModel, SessionSeatsResponse } from '@dropshield/shared';

@Component({
  selector: 'app-seat-map',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-xl">
      <!-- Session Header -->
      <div class="border-b border-slate-800 pb-5 mb-6 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 class="text-xl font-bold text-white">{{ seatData()?.eventTitle || 'Event Seating Plan' }}</h2>
          <p class="text-xs text-slate-400 mt-1">
            📍 {{ seatData()?.venueName }} • Authoritative live inventory synchronized with Redis
          </p>
        </div>
        <!-- Refresh Button -->
        <button
          (click)="loadSeats()"
          [disabled]="isLoading()"
          class="px-3 py-1.5 rounded-lg text-xs bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 flex items-center space-x-1 transition"
        >
          <span>🔄</span>
          <span>Refresh Map</span>
        </button>
      </div>

      <!-- Inventory Legend -->
      <div class="flex flex-wrap items-center justify-center gap-6 py-3 px-4 bg-slate-950/60 rounded-xl border border-slate-800/80 mb-8 text-xs font-medium">
        <div class="flex items-center space-x-2">
          <div class="w-4 h-4 rounded bg-slate-800 border-2 border-emerald-500/80"></div>
          <span class="text-slate-300">Available ({{ seatData()?.summary?.available || 0 }})</span>
        </div>
        <div class="flex items-center space-x-2">
          <div class="w-4 h-4 rounded bg-teal-500 border-2 border-teal-300 shadow-sm shadow-teal-500/50"></div>
          <span class="text-teal-300 font-semibold">Selected ({{ selectedSeatIds().length }})</span>
        </div>
        <div class="flex items-center space-x-2">
          <div class="w-4 h-4 rounded bg-amber-500/20 border-2 border-amber-500/60 flex items-center justify-center text-[9px] text-amber-400">⏱</div>
          <span class="text-amber-400">Held (Lease active: {{ seatData()?.summary?.held || 0 }})</span>
        </div>
        <div class="flex items-center space-x-2">
          <div class="w-4 h-4 rounded bg-slate-800 border border-slate-700 opacity-40"></div>
          <span class="text-slate-500">Booked ({{ seatData()?.summary?.booked || 0 }})</span>
        </div>
      </div>

      <!-- Stage Visual -->
      <div class="w-full max-w-lg mx-auto mb-10 text-center">
        <div class="h-2.5 w-full bg-gradient-to-r from-teal-500/20 via-teal-400/80 to-teal-500/20 rounded-full shadow-lg shadow-teal-500/20 mb-2"></div>
        <span class="text-[11px] font-bold uppercase tracking-widest text-slate-400">STAGE / SCREEN AREA</span>
      </div>

      <!-- Loading / Error Notices -->
      @if (isLoading()) {
        <div class="py-16 text-center text-slate-400 text-sm">
          <div class="inline-block w-8 h-8 border-2 border-teal-400 border-t-transparent rounded-full animate-spin mb-3"></div>
          <div>Loading authoritative seating plan...</div>
        </div>
      } @else if (errorMessage()) {
        <div class="p-4 mb-6 rounded-xl bg-red-950/40 border border-red-800/80 text-red-300 text-sm flex items-start space-x-3">
          <span class="text-lg">⚠️</span>
          <div class="flex-1">
            <div class="font-semibold">{{ errorMessage() }}</div>
            <div class="text-xs text-red-400 mt-1">Please re-select available seats.</div>
          </div>
        </div>
      }

      <!-- Interactive Grid by Sections -->
      @if (!isLoading() && seatData()) {
        <div class="space-y-8">
          @for (sec of groupedSections(); track sec.name) {
            <div class="bg-slate-950/40 border border-slate-800/80 rounded-xl p-5">
              <div class="flex items-center justify-between border-b border-slate-800 pb-2 mb-4">
                <span class="font-bold text-sm text-slate-200 uppercase tracking-wide">{{ sec.name }} Section</span>
                <span class="text-xs text-teal-400 font-mono">₹{{ formatPrice(sec.priceMinor) }} / seat</span>
              </div>

              <!-- Rows -->
              <div class="space-y-3">
                @for (row of sec.rows; track row.label) {
                  <div class="flex items-center space-x-3">
                    <span class="w-6 text-xs font-bold text-slate-400 text-center font-mono">{{ row.label }}</span>
                    <div class="flex flex-wrap gap-2">
                      @for (seat of row.seats; track seat.id) {
                        <button
                          type="button"
                          [disabled]="seat.status !== 'AVAILABLE'"
                          (click)="toggleSeat(seat)"
                          [ngClass]="getSeatClasses(seat)"
                          class="w-8 h-8 rounded-lg text-xs font-bold transition flex items-center justify-center font-mono relative group"
                        >
                          {{ seat.seatNumber }}
                          @if (seat.status === 'HELD') {
                            <span class="absolute -top-1 -right-1 w-2.5 h-2.5 rounded-full bg-amber-400 animate-pulse"></span>
                          }
                        </button>
                      }
                    </div>
                  </div>
                }
              </div>
            </div>
          }
        </div>
      }

      <!-- Bottom Selection Floating Bar -->
      @if (selectedSeatIds().length > 0) {
        <div class="mt-8 pt-5 border-t border-slate-800 flex flex-wrap items-center justify-between gap-4 bg-slate-950/80 p-4 rounded-xl border border-teal-500/30">
          <div>
            <div class="text-xs text-slate-400">Selected Seats:</div>
            <div class="text-sm font-semibold text-white flex items-center space-x-2 mt-0.5">
              <span>{{ selectedSeatsSummary() }}</span>
              <span class="text-xs text-slate-500 font-normal">({{ selectedSeatIds().length }}/10 max)</span>
            </div>
          </div>

          <div class="flex items-center space-x-4">
            <div class="text-right">
              <div class="text-xs text-slate-400">Total Price</div>
              <div class="text-xl font-bold text-teal-400 font-mono">₹{{ formatPrice(totalPriceMinor()) }}</div>
            </div>

            <button
              (click)="onHoldSeats()"
              [disabled]="isHolding()"
              class="px-6 py-2.5 rounded-xl text-sm font-bold bg-teal-500 hover:bg-teal-400 text-slate-950 transition shadow-lg shadow-teal-500/20 disabled:opacity-50 flex items-center space-x-2"
            >
              @if (isHolding()) {
                <span class="w-4 h-4 border-2 border-slate-950 border-t-transparent rounded-full animate-spin"></span>
                <span>Holding Seats...</span>
              } @else {
                <span>🔒 Reserve & Checkout</span>
              }
            </button>
          </div>
        </div>
      }
    </div>
  `,
})
export class SeatMapComponent implements OnInit {
  @Input({ required: true }) sessionId!: string;

  private readonly eventService = inject(EventService);
  private readonly bookingService = inject(BookingService);
  private readonly authService = inject(AuthService);
  private readonly router = inject(Router);

  readonly seatData = signal<SessionSeatsResponse | null>(null);
  readonly selectedSeatIds = signal<string[]>([]);
  readonly isLoading = signal<boolean>(true);
  readonly isHolding = signal<boolean>(false);
  readonly errorMessage = signal<string | null>(null);

  readonly selectedSeats = computed(() => {
    const data = this.seatData();
    if (!data) return [];
    return data.seats.filter((s) => this.selectedSeatIds().includes(s.id));
  });

  readonly totalPriceMinor = computed(() => {
    return this.selectedSeats().reduce((sum, s) => sum + s.priceMinor, 0);
  });

  readonly selectedSeatsSummary = computed(() => {
    const seats = this.selectedSeats();
    if (seats.length === 0) return 'None';
    return seats.map((s) => `${s.rowLabel}${s.seatNumber}`).join(', ');
  });

  readonly groupedSections = computed(() => {
    const data = this.seatData();
    if (!data) return [];

    const sectionsMap = new Map<string, { name: string; priceMinor: number; rows: { label: string; seats: SeatModel[] }[] }>();

    for (const seat of data.seats) {
      if (!sectionsMap.has(seat.section)) {
        sectionsMap.set(seat.section, {
          name: seat.section,
          priceMinor: seat.priceMinor,
          rows: [],
        });
      }

      const sec = sectionsMap.get(seat.section)!;
      let row = sec.rows.find((r) => r.label === seat.rowLabel);
      if (!row) {
        row = { label: seat.rowLabel, seats: [] };
        sec.rows.push(row);
      }
      row.seats.push(seat);
    }

    return Array.from(sectionsMap.values());
  });

  ngOnInit(): void {
    this.loadSeats();
  }

  loadSeats(): void {
    this.isLoading.set(true);
    this.errorMessage.set(null);
    this.eventService.getSessionSeats(this.sessionId).subscribe({
      next: (data) => {
        this.seatData.set(data);
        this.isLoading.set(false);
        // Deselect seats that are no longer available
        this.selectedSeatIds.update((ids) =>
          ids.filter((id) => data.seats.some((s) => s.id === id && s.status === 'AVAILABLE'))
        );
      },
      error: (err) => {
        this.isLoading.set(false);
        this.errorMessage.set('Failed to load seating inventory. Please try again.');
      },
    });
  }

  toggleSeat(seat: SeatModel): void {
    if (seat.status !== 'AVAILABLE') return;

    this.selectedSeatIds.update((current) => {
      if (current.includes(seat.id)) {
        return current.filter((id) => id !== seat.id);
      } else {
        if (current.length >= 10) {
          this.errorMessage.set('Maximum 10 seats allowed per booking request.');
          return current;
        }
        return [...current, seat.id];
      }
    });
  }

  getSeatClasses(seat: SeatModel): string {
    const isSelected = this.selectedSeatIds().includes(seat.id);

    if (isSelected) {
      return 'bg-teal-500 text-slate-950 font-extrabold shadow-lg shadow-teal-500/50 scale-105 border-2 border-white';
    }

    switch (seat.status) {
      case 'AVAILABLE':
        return 'bg-slate-800 text-slate-200 border-2 border-emerald-500/70 hover:border-emerald-400 hover:bg-slate-700 cursor-pointer';
      case 'HELD':
        return 'bg-amber-500/20 text-amber-400 border border-amber-500/40 cursor-not-allowed opacity-60';
      case 'BOOKED':
      default:
        return 'bg-slate-800/40 text-slate-600 border border-slate-800 cursor-not-allowed opacity-30 line-through';
    }
  }

  formatPrice(priceMinor: number): string {
    return (priceMinor / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 });
  }

  onHoldSeats(): void {
    if (this.selectedSeatIds().length === 0) return;

    if (!this.authService.isLoggedIn()) {
      // Redirect to login
      this.router.navigate(['/login']);
      return;
    }

    this.isHolding.set(true);
    this.errorMessage.set(null);

    this.bookingService.createReservation(this.sessionId, this.selectedSeatIds()).subscribe({
      next: (res) => {
        this.isHolding.set(false);
        this.router.navigate(['/checkout', res.reservationId]);
      },
      error: (err) => {
        this.isHolding.set(false);
        const code = err.error?.error?.code;
        if (code === 'SEAT_UNAVAILABLE') {
          this.errorMessage.set('One or more selected seats were just claimed by another user. Please re-select seats.');
        } else {
          this.errorMessage.set(err.error?.error?.message || 'Failed to hold seats. Please try again.');
        }
        this.loadSeats();
      },
    });
  }
}
