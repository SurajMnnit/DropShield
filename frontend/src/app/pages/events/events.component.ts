import { Component, OnInit, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterLink } from '@angular/router';
import { EventService } from '../../services/event.service.js';
import type { EventModel } from '@dropshield/shared';

@Component({
  selector: 'app-events',
  standalone: true,
  imports: [CommonModule, RouterLink],
  template: `
    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-10">
      <!-- Hero Banner -->
      <div class="bg-gradient-to-r from-teal-950/40 via-slate-900 to-indigo-950/40 border border-slate-800 rounded-3xl p-8 md:p-12 mb-10 shadow-2xl relative overflow-hidden">
        <div class="relative z-10 max-w-2xl">
          <span class="inline-flex items-center px-3 py-1 rounded-full text-xs font-semibold bg-teal-500/10 text-teal-400 border border-teal-500/20 mb-4">
            🔥 High-Concurrency Distributed Booking Engine
          </span>
          <h1 class="text-3xl md:text-5xl font-extrabold text-white tracking-tight leading-tight">
            Discover Live Events with <span class="text-teal-400">Atomic</span> Seat Protection.
          </h1>
          <p class="text-slate-300 text-sm md:text-base mt-4 leading-relaxed">
            Every seat reservation is guarded by distributed Redis Lua locks and transactional PostgreSQL integrity. Zero overselling, instant hold leases, and guaranteed ACID consistency.
          </p>
        </div>
      </div>

      <!-- Category Filter Pills -->
      <div class="flex items-center space-x-2 overflow-x-auto pb-4 mb-8">
        @for (cat of categories; track cat) {
          <button
            type="button"
            (click)="selectCategory(cat)"
            [ngClass]="selectedCategory() === cat ? 'bg-teal-500 text-slate-950 font-bold shadow-sm' : 'bg-slate-900 text-slate-300 hover:bg-slate-800 border border-slate-800'"
            class="px-4 py-2 rounded-xl text-xs whitespace-nowrap transition cursor-pointer"
          >
            {{ cat }}
          </button>
        }
      </div>

      <!-- Events Grid -->
      @if (isLoading()) {
        <div class="py-20 text-center text-slate-400">
          <div class="inline-block w-8 h-8 border-2 border-teal-400 border-t-transparent rounded-full animate-spin mb-3"></div>
          <div>Loading published events...</div>
        </div>
      } @else if (events().length === 0) {
        <div class="bg-slate-900 border border-slate-800 rounded-2xl p-12 text-center text-slate-400">
          <div class="text-4xl mb-3">🎫</div>
          <h3 class="text-lg font-bold text-white mb-1">No Events Found</h3>
          <p class="text-sm">There are currently no published events in this category.</p>
        </div>
      } @else {
        <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          @for (event of events(); track event.id) {
            <div class="bg-slate-900 border border-slate-800 hover:border-slate-700 rounded-2xl p-6 transition flex flex-col justify-between group shadow-lg">
              <div>
                <div class="flex items-center justify-between mb-4">
                  <span class="px-2.5 py-1 rounded-md text-[11px] font-semibold tracking-wide uppercase bg-teal-500/10 text-teal-400 border border-teal-500/20">
                    {{ event.category }}
                  </span>
                  <span class="text-xs text-slate-500 font-mono">
                    {{ event.sessionsCount || 0 }} Session(s)
                  </span>
                </div>

                <h3 class="text-xl font-bold text-white group-hover:text-teal-400 transition mb-2">
                  {{ event.title }}
                </h3>
                <p class="text-slate-400 text-xs line-clamp-3 leading-relaxed mb-6">
                  {{ event.description || 'Join us for this premier live event. Reserve your seats with instant atomic lock guarantees.' }}
                </p>
              </div>

              <div class="pt-4 border-t border-slate-800 flex items-center justify-between">
                <span class="text-xs text-slate-400">Live Ticketing</span>
                <a
                  [routerLink]="['/events', event.id]"
                  class="px-4 py-2 rounded-xl text-xs font-bold bg-teal-500/10 hover:bg-teal-500 text-teal-400 hover:text-slate-950 border border-teal-500/30 transition flex items-center space-x-1"
                >
                  <span>Select Seats</span>
                  <span>→</span>
                </a>
              </div>
            </div>
          }
        </div>
      }
    </div>
  `,
})
export class EventsComponent implements OnInit {
  private readonly eventService = inject(EventService);

  readonly events = signal<EventModel[]>([]);
  readonly isLoading = signal<boolean>(true);
  readonly selectedCategory = signal<string>('All');

  readonly categories = ['All', 'Music', 'Tech', 'Sports', 'Classical', 'Arts', 'Comedy'];

  ngOnInit(): void {
    this.loadEvents();
  }

  loadEvents(): void {
    this.isLoading.set(true);
    const category = this.selectedCategory() === 'All' ? undefined : this.selectedCategory();
    this.eventService.getEvents({ category }).subscribe({
      next: (data) => {
        this.events.set(data.events || []);
        this.isLoading.set(false);
      },
      error: () => {
        this.isLoading.set(false);
      },
    });
  }

  selectCategory(category: string): void {
    this.selectedCategory.set(category);
    this.loadEvents();
  }
}
