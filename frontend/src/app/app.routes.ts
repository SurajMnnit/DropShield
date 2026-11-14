import { Routes } from '@angular/router';

export const routes: Routes = [
  {
    path: '',
    redirectTo: 'events',
    pathMatch: 'full',
  },
  {
    path: 'events',
    loadComponent: () =>
      import('./pages/events/events.component.js').then((m) => m.EventsComponent),
  },
  {
    path: 'events/:id',
    loadComponent: () =>
      import('./pages/event-detail/event-detail.component.js').then((m) => m.EventDetailComponent),
  },
  {
    path: 'booking/:sessionId',
    loadComponent: () =>
      import('./pages/booking/booking.component.js').then((m) => m.BookingComponent),
  },
  {
    path: 'checkout/:reservationId',
    loadComponent: () =>
      import('./pages/checkout/checkout.component.js').then((m) => m.CheckoutComponent),
  },
  {
    path: 'confirmation/:bookingId',
    loadComponent: () =>
      import('./pages/confirmation/confirmation.component.js').then((m) => m.ConfirmationComponent),
  },
  {
    path: 'bookings',
    loadComponent: () =>
      import('./pages/booking-history/booking-history.component.js').then((m) => m.BookingHistoryComponent),
  },
  {
    path: 'login',
    loadComponent: () =>
      import('./pages/login/login.component.js').then((m) => m.LoginComponent),
  },
  {
    path: 'register',
    loadComponent: () =>
      import('./pages/register/register.component.js').then((m) => m.RegisterComponent),
  },
  {
    path: 'admin',
    loadComponent: () =>
      import('./pages/admin/admin.component.js').then((m) => m.AdminComponent),
  },
  {
    path: '**',
    redirectTo: 'events',
  },
];
