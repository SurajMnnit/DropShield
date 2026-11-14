import { Component, OnInit, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ReactiveFormsModule, FormBuilder, Validators } from '@angular/forms';
import { Router } from '@angular/router';
import { EventService } from '../../services/event.service.js';
import { AuthService } from '../../services/auth.service.js';
import type { EventModel } from '@dropshield/shared';

@Component({
  selector: 'app-admin',
  standalone: true,
  imports: [CommonModule, ReactiveFormsModule],
  template: `
    <div class="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-10">
      <!-- Admin Header -->
      <div class="border-b border-slate-800 pb-6 mb-8 flex flex-wrap items-center justify-between gap-4">
        <div>
          <div class="flex items-center space-x-2">
            <span class="px-2.5 py-0.5 rounded text-[11px] font-mono font-bold bg-amber-500/10 text-amber-400 border border-amber-500/20">
              ⚡ Admin Console
            </span>
            <span class="text-xs text-slate-500">DropShield Control Plane</span>
          </div>
          <h1 class="text-3xl font-extrabold text-white mt-1">Platform Operations</h1>
        </div>

        <div class="flex items-center space-x-3 text-xs">
          <span class="flex items-center space-x-1.5 text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 px-3 py-1 rounded-full">
            <span class="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
            <span>Cluster Healthy</span>
          </span>
        </div>
      </div>

      <!-- Quick Metrics Cards -->
      <div class="grid grid-cols-1 md:grid-cols-3 gap-6 mb-10">
        <div class="p-6 rounded-2xl bg-slate-900 border border-slate-800">
          <div class="text-xs text-slate-400 mb-1">Total Published Events</div>
          <div class="text-3xl font-bold text-white font-mono">{{ events().length }}</div>
          <div class="text-[11px] text-teal-400 mt-2">Active in discovery catalog</div>
        </div>

        <div class="p-6 rounded-2xl bg-slate-900 border border-slate-800">
          <div class="text-xs text-slate-400 mb-1">Inventory Engine</div>
          <div class="text-3xl font-bold text-emerald-400 font-mono">Redis 7 AOF</div>
          <div class="text-[11px] text-slate-400 mt-2">Atomic Lua Seat Hold TTL Leases</div>
        </div>

        <div class="p-6 rounded-2xl bg-slate-900 border border-slate-800">
          <div class="text-xs text-slate-400 mb-1">Persistent Ledger</div>
          <div class="text-3xl font-bold text-indigo-400 font-mono">PostgreSQL 16</div>
          <div class="text-[11px] text-slate-400 mt-2">Trigger-enforced immutable ledger</div>
        </div>
      </div>

      <div class="grid grid-cols-1 lg:grid-cols-2 gap-8">
        <!-- Create Event Form -->
        <div class="bg-slate-900 border border-slate-800 rounded-3xl p-6 sm:p-8 shadow-xl">
          <h2 class="text-xl font-bold text-white mb-2">Create New Event</h2>
          <p class="text-xs text-slate-400 mb-6">Publish an event to the DropShield ticketing platform</p>

          @if (eventSuccessMessage()) {
            <div class="p-3 mb-6 rounded-xl bg-emerald-950/40 border border-emerald-800 text-emerald-300 text-xs flex items-center space-x-2">
              <span>✓</span>
              <span>{{ eventSuccessMessage() }}</span>
            </div>
          }

          <form [formGroup]="createEventForm" (ngSubmit)="onCreateEvent()" class="space-y-4">
            <div>
              <label class="block text-xs font-semibold text-slate-300 mb-1.5">Event Title</label>
              <input
                type="text"
                formControlName="title"
                placeholder="e.g. World Electronic Music Summit"
                class="w-full px-4 py-2.5 rounded-xl bg-slate-950 border border-slate-800 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-teal-500 transition"
              />
            </div>

            <div>
              <label class="block text-xs font-semibold text-slate-300 mb-1.5">Category</label>
              <select
                formControlName="category"
                class="w-full px-4 py-2.5 rounded-xl bg-slate-950 border border-slate-800 text-sm text-white focus:outline-none focus:border-teal-500 transition"
              >
                <option value="Music">Music</option>
                <option value="Tech">Tech</option>
                <option value="Sports">Sports</option>
                <option value="Classical">Classical</option>
                <option value="Arts">Arts</option>
                <option value="Comedy">Comedy</option>
              </select>
            </div>

            <div>
              <label class="block text-xs font-semibold text-slate-300 mb-1.5">Description</label>
              <textarea
                formControlName="description"
                rows="3"
                placeholder="Event description, lineup, venue guidelines..."
                class="w-full px-4 py-2.5 rounded-xl bg-slate-950 border border-slate-800 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-teal-500 transition resize-none"
              ></textarea>
            </div>

            <button
              type="submit"
              [disabled]="createEventForm.invalid || isSubmittingEvent()"
              class="w-full py-2.5 px-4 rounded-xl text-xs font-bold bg-teal-500 hover:bg-teal-400 text-slate-950 transition shadow-lg shadow-teal-500/20 disabled:opacity-50 flex items-center justify-center space-x-2 cursor-pointer"
            >
              @if (isSubmittingEvent()) {
                <span>Publishing Event...</span>
              } @else {
                <span>Publish Event</span>
              }
            </button>
          </form>
        </div>

        <!-- Published Events List -->
        <div class="bg-slate-900 border border-slate-800 rounded-3xl p-6 sm:p-8 shadow-xl flex flex-col justify-between">
          <div>
            <h2 class="text-xl font-bold text-white mb-2">Managed Events</h2>
            <p class="text-xs text-slate-400 mb-6">Catalog of active events and sessions</p>

            <div class="space-y-3 max-h-[380px] overflow-y-auto pr-2">
              @for (event of events(); track event.id) {
                <div class="p-4 rounded-xl bg-slate-950/60 border border-slate-800 flex items-center justify-between">
                  <div>
                    <div class="text-sm font-bold text-white">{{ event.title }}</div>
                    <div class="text-[11px] text-slate-400 flex items-center space-x-2 mt-0.5">
                      <span class="text-teal-400 font-medium">{{ event.category }}</span>
                      <span>•</span>
                      <span>{{ event.sessionsCount || 0 }} session(s)</span>
                    </div>
                  </div>
                  <span class="px-2 py-0.5 rounded text-[10px] font-mono bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                    PUBLISHED
                  </span>
                </div>
              }
            </div>
          </div>
        </div>
      </div>
    </div>
  `,
})
export class AdminComponent implements OnInit {
  private readonly fb = inject(FormBuilder);
  private readonly eventService = inject(EventService);
  private readonly authService = inject(AuthService);
  private readonly router = inject(Router);

  readonly events = signal<EventModel[]>([]);
  readonly isSubmittingEvent = signal<boolean>(false);
  readonly eventSuccessMessage = signal<string | null>(null);

  readonly createEventForm = this.fb.group({
    title: ['', [Validators.required, Validators.minLength(3)]],
    category: ['Music', [Validators.required]],
    description: [''],
  });

  ngOnInit(): void {
    if (!this.authService.isAdmin()) {
      this.router.navigate(['/events']);
      return;
    }
    this.loadEvents();
  }

  loadEvents(): void {
    this.eventService.getEvents().subscribe({
      next: (data) => {
        this.events.set(data.events || []);
      },
    });
  }

  onCreateEvent(): void {
    if (this.createEventForm.invalid) return;

    this.isSubmittingEvent.set(true);
    this.eventSuccessMessage.set(null);

    const { title, category, description } = this.createEventForm.getRawValue();

    this.eventService
      .createEvent({
        title: title!,
        category: category!,
        description: description || '',
      })
      .subscribe({
        next: () => {
          this.isSubmittingEvent.set(false);
          this.eventSuccessMessage.set('Event created and published successfully!');
          this.createEventForm.reset({ category: 'Music' });
          this.loadEvents();
        },
        error: () => {
          this.isSubmittingEvent.set(false);
        },
      });
  }
}
