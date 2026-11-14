import { Component, Input, OnInit, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterLink } from '@angular/router';
import { EventService } from '../../services/event.service.js';
import type { EventModel, SessionModel } from '@dropshield/shared';

@Component({
  selector: 'app-event-detail',
  standalone: true,
  imports: [CommonModule, RouterLink],
  template: `
    <div class="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-10">
      <!-- Back Navigation -->
      <a routerLink="/events" class="inline-flex items-center text-xs font-semibold text-slate-400 hover:text-teal-400 transition mb-6">
        <span class="mr-1">←</span> Back to Events
      </a>

      @if (isLoading()) {
        <div class="py-24 text-center text-slate-400">
          <div class="inline-block w-8 h-8 border-2 border-teal-400 border-t-transparent rounded-full animate-spin mb-3"></div>
          <div>Loading event details...</div>
        </div>
      } @else if (event()) {
        <!-- Event Header Card -->
        <div class="bg-slate-900 border border-slate-800 rounded-3xl p-8 mb-10 shadow-xl">
          <div class="flex items-center space-x-3 mb-4">
            <span class="px-3 py-1 rounded-md text-xs font-bold uppercase tracking-wider bg-teal-500/10 text-teal-400 border border-teal-500/20">
              {{ event()?.category }}
            </span>
            <span class="text-xs text-slate-500">Event ID: {{ event()?.id?.slice(0, 8) }}</span>
          </div>

          <h1 class="text-3xl md:text-4xl font-extrabold text-white mb-4">
            {{ event()?.title }}
          </h1>

          <p class="text-slate-300 text-sm md:text-base leading-relaxed max-w-3xl">
            {{ event()?.description || 'Premier live event hosted on DropShield platform with atomic seat hold leases.' }}
          </p>
        </div>

        <!-- Available Sessions Schedule -->
        <div class="space-y-4">
          <div class="flex items-center justify-between mb-2">
            <h2 class="text-xl font-bold text-white">Upcoming Sessions & Venues</h2>
            <span class="text-xs text-slate-400">{{ sessions().length }} session(s) scheduled</span>
          </div>

          @if (sessions().length === 0) {
            <div class="p-8 rounded-2xl bg-slate-900 border border-slate-800 text-center text-slate-400 text-sm">
              No active sessions are currently scheduled for this event.
            </div>
          } @else {
            <div class="grid grid-cols-1 gap-4">
              @for (session of sessions(); track session.id) {
                <div class="bg-slate-900/90 border border-slate-800 hover:border-slate-700 rounded-2xl p-6 transition flex flex-col md:flex-row md:items-center justify-between gap-6">
                  <div class="space-y-2">
                    <div class="flex items-center space-x-3">
                      <span class="text-base font-bold text-white">
                        📍 {{ session.venueName || 'Main Arena' }}
                      </span>
                      <span class="px-2 py-0.5 rounded text-[10px] font-mono bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                        {{ session.status }}
                      </span>
                    </div>

                    <div class="text-xs text-slate-400 flex flex-wrap items-center gap-3">
                      <span>{{ session.venueAddress }}, {{ session.venueCity }}</span>
                      <span>•</span>
                      <span class="text-teal-400 font-medium">Starts: {{ formatDate(session.startsAt) }}</span>
                    </div>
                  </div>

                  <div>
                    <a
                      [routerLink]="['/booking', session.id]"
                      class="inline-flex items-center justify-center px-6 py-2.5 rounded-xl text-xs font-bold bg-teal-500 hover:bg-teal-400 text-slate-950 transition shadow-lg shadow-teal-500/20"
                    >
                      <span>Choose Seats</span>
                      <span class="ml-1.5">→</span>
                    </a>
                  </div>
                </div>
              }
            </div>
          }
        </div>
      }
    </div>
  `,
})
export class EventDetailComponent implements OnInit {
  @Input({ required: true }) id!: string;

  private readonly eventService = inject(EventService);

  readonly event = signal<EventModel | null>(null);
  readonly sessions = signal<SessionModel[]>([]);
  readonly isLoading = signal<boolean>(true);

  ngOnInit(): void {
    if (this.id) {
      this.loadEvent();
    }
  }

  loadEvent(): void {
    this.isLoading.set(true);
    this.eventService.getEvent(this.id).subscribe({
      next: (data) => {
        this.event.set(data.event);
        this.sessions.set(data.sessions || []);
        this.isLoading.set(false);
      },
      error: () => {
        this.isLoading.set(false);
      },
    });
  }

  formatDate(dateStr: string): string {
    return new Date(dateStr).toLocaleString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }
}
