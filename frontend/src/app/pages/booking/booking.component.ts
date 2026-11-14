import { Component, Input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterLink } from '@angular/router';
import { SeatMapComponent } from '../../components/seat-map/seat-map.component.js';

@Component({
  selector: 'app-booking',
  standalone: true,
  imports: [CommonModule, RouterLink, SeatMapComponent],
  template: `
    <div class="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-10">
      <!-- Back Navigation -->
      <a routerLink="/events" class="inline-flex items-center text-xs font-semibold text-slate-400 hover:text-teal-400 transition mb-6">
        <span class="mr-1">←</span> Back to Events
      </a>

      @if (sessionId) {
        <app-seat-map [sessionId]="sessionId" />
      } @else {
        <div class="p-8 text-center text-red-400 bg-red-950/20 border border-red-800 rounded-2xl text-sm">
          No session specified.
        </div>
      }
    </div>
  `,
})
export class BookingComponent {
  @Input({ required: true }) sessionId!: string;
}
