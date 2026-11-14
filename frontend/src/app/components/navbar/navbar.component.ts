import { Component, inject } from '@angular/core';
import { Router, RouterLink, RouterLinkActive } from '@angular/router';
import { CommonModule } from '@angular/common';
import { AuthService } from '../../services/auth.service.js';

@Component({
  selector: 'app-navbar',
  standalone: true,
  imports: [CommonModule, RouterLink, RouterLinkActive],
  template: `
    <header class="bg-slate-900/95 border-b border-slate-800 sticky top-0 z-50 backdrop-blur">
      <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
        <!-- Logo & Navigation Links -->
        <div class="flex items-center space-x-8">
          <a routerLink="/" class="flex items-center space-x-3 text-white font-bold text-xl group">
            <div class="w-9 h-9 rounded-lg bg-teal-500/10 border border-teal-500/30 flex items-center justify-center text-teal-400 group-hover:scale-105 transition shadow-sm">
              🛡️
            </div>
            <span>Drop<span class="text-teal-400">Shield</span></span>
          </a>

          <nav class="hidden md:flex items-center space-x-6 text-sm font-medium">
            <a
              routerLink="/events"
              routerLinkActive="text-teal-400"
              class="text-slate-300 hover:text-white transition"
            >
              Events
            </a>
            @if (authService.isLoggedIn()) {
              <a
                routerLink="/bookings"
                routerLinkActive="text-teal-400"
                class="text-slate-300 hover:text-white transition"
              >
                My Bookings
              </a>
            }
            @if (authService.isAdmin()) {
              <a
                routerLink="/admin"
                routerLinkActive="text-teal-400"
                class="text-amber-400 hover:text-amber-300 transition flex items-center space-x-1"
              >
                <span>⚡ Admin Dashboard</span>
              </a>
            }
          </nav>
        </div>

        <!-- Auth Actions -->
        <div class="flex items-center space-x-4">
          @if (authService.isLoggedIn()) {
            <div class="flex items-center space-x-3">
              <div class="text-right hidden sm:block">
                <div class="text-sm font-semibold text-slate-200">
                  {{ authService.currentUser()?.name }}
                </div>
                <div class="text-xs text-slate-400 capitalize">
                  {{ authService.currentUser()?.role }}
                </div>
              </div>
              <button
                (click)="onLogout()"
                class="px-3 py-1.5 rounded-lg text-xs font-medium bg-slate-800 text-slate-300 hover:bg-slate-700 hover:text-white border border-slate-700 transition"
              >
                Sign Out
              </button>
            </div>
          } @else {
            <div class="flex items-center space-x-3">
              <a
                routerLink="/login"
                class="text-sm font-medium text-slate-300 hover:text-white transition px-3 py-1.5"
              >
                Sign In
              </a>
              <a
                routerLink="/register"
                class="px-4 py-2 rounded-lg text-sm font-semibold bg-teal-500 hover:bg-teal-400 text-slate-950 transition shadow-sm"
              >
                Get Started
              </a>
            </div>
          }
        </div>
      </div>
    </header>
  `,
})
export class NavbarComponent {
  readonly authService = inject(AuthService);
  private readonly router = inject(Router);

  onLogout(): void {
    this.authService.logout().subscribe({
      next: () => {
        this.router.navigate(['/login']);
      },
    });
  }
}
