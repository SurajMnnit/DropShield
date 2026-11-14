import { Component, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ReactiveFormsModule, FormBuilder, Validators } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { AuthService } from '../../services/auth.service.js';

@Component({
  selector: 'app-register',
  standalone: true,
  imports: [CommonModule, ReactiveFormsModule, RouterLink],
  template: `
    <div class="min-h-[calc(100vh-12rem)] flex items-center justify-center px-4 sm:px-6 lg:px-8 py-12">
      <div class="max-w-md w-full bg-slate-900 border border-slate-800 rounded-3xl p-8 shadow-2xl">
        <!-- Header -->
        <div class="text-center mb-8">
          <div class="w-12 h-12 rounded-xl bg-teal-500/10 border border-teal-500/30 flex items-center justify-center text-teal-400 text-2xl mx-auto mb-3 shadow-lg shadow-teal-500/10">
            🛡️
          </div>
          <h2 class="text-2xl font-extrabold text-white">Create an Account</h2>
          <p class="text-xs text-slate-400 mt-1">Join DropShield for high-concurrency ticket reservations</p>
        </div>

        @if (errorMessage()) {
          <div class="p-3.5 mb-6 rounded-xl bg-red-950/40 border border-red-800 text-red-300 text-xs flex items-center space-x-2">
            <span>⚠️</span>
            <span>{{ errorMessage() }}</span>
          </div>
        }

        <!-- Form -->
        <form [formGroup]="registerForm" (ngSubmit)="onSubmit()" class="space-y-4">
          <div>
            <label class="block text-xs font-semibold text-slate-300 mb-1.5">Full Name</label>
            <input
              type="text"
              formControlName="name"
              placeholder="Ada Lovelace"
              class="w-full px-4 py-2.5 rounded-xl bg-slate-950 border border-slate-800 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-teal-500 transition"
            />
            @if (registerForm.get('name')?.touched && registerForm.get('name')?.invalid) {
              <div class="text-[11px] text-red-400 mt-1">Name must be at least 2 characters.</div>
            }
          </div>

          <div>
            <label class="block text-xs font-semibold text-slate-300 mb-1.5">Email Address</label>
            <input
              type="email"
              formControlName="email"
              placeholder="ada@example.com"
              class="w-full px-4 py-2.5 rounded-xl bg-slate-950 border border-slate-800 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-teal-500 transition font-mono"
            />
            @if (registerForm.get('email')?.touched && registerForm.get('email')?.invalid) {
              <div class="text-[11px] text-red-400 mt-1">Please enter a valid email address.</div>
            }
          </div>

          <div>
            <label class="block text-xs font-semibold text-slate-300 mb-1.5">Password</label>
            <input
              type="password"
              formControlName="password"
              placeholder="••••••••"
              class="w-full px-4 py-2.5 rounded-xl bg-slate-950 border border-slate-800 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-teal-500 transition"
            />
            <div class="text-[11px] text-slate-500 mt-1">Min 8 chars, 1 uppercase letter, and 1 number.</div>
            @if (registerForm.get('password')?.touched && registerForm.get('password')?.invalid) {
              <div class="text-[11px] text-red-400 mt-1">Password requirements not met.</div>
            }
          </div>

          <div>
            <label class="block text-xs font-semibold text-slate-300 mb-1.5">Account Role</label>
            <select
              formControlName="role"
              class="w-full px-4 py-2.5 rounded-xl bg-slate-950 border border-slate-800 text-sm text-white focus:outline-none focus:border-teal-500 transition"
            >
              <option value="buyer">Ticket Buyer (Standard)</option>
              <option value="admin">Event Organizer / Admin</option>
            </select>
          </div>

          <button
            type="submit"
            [disabled]="registerForm.invalid || isLoading()"
            class="w-full py-3 px-4 rounded-xl text-sm font-bold bg-teal-500 hover:bg-teal-400 text-slate-950 transition shadow-lg shadow-teal-500/20 disabled:opacity-50 flex items-center justify-center space-x-2 cursor-pointer mt-6"
          >
            @if (isLoading()) {
              <span class="w-4 h-4 border-2 border-slate-950 border-t-transparent rounded-full animate-spin"></span>
              <span>Creating Account...</span>
            } @else {
              <span>Create Account</span>
            }
          </button>
        </form>

        <!-- Footer link -->
        <div class="text-center mt-6 text-xs text-slate-400">
          Already have an account?
          <a routerLink="/login" class="text-teal-400 font-semibold hover:underline ml-1">Sign in here</a>
        </div>
      </div>
    </div>
  `,
})
export class RegisterComponent {
  private readonly fb = inject(FormBuilder);
  private readonly authService = inject(AuthService);
  private readonly router = inject(Router);

  readonly isLoading = signal<boolean>(false);
  readonly errorMessage = signal<string | null>(null);

  readonly registerForm = this.fb.group({
    name: ['', [Validators.required, Validators.minLength(2)]],
    email: ['', [Validators.required, Validators.email]],
    password: [
      '',
      [
        Validators.required,
        Validators.minLength(8),
        Validators.pattern(/^(?=.*[A-Z])(?=.*\d).*$/),
      ],
    ],
    role: ['buyer', [Validators.required]],
  });

  onSubmit(): void {
    if (this.registerForm.invalid) {
      this.registerForm.markAllAsTouched();
      return;
    }

    this.isLoading.set(true);
    this.errorMessage.set(null);

    const { name, email, password, role } = this.registerForm.getRawValue();

    this.authService
      .register({
        name: name!,
        email: email!,
        password: password!,
        role: role as 'buyer' | 'admin',
      })
      .subscribe({
        next: () => {
          this.isLoading.set(false);
          this.router.navigate(['/events']);
        },
        error: (err) => {
          this.isLoading.set(false);
          this.errorMessage.set(
            err.error?.error?.message || 'Registration failed. Email may already be in use.'
          );
        },
      });
  }
}
