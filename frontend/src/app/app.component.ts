import { Component, signal } from '@angular/core';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [],
  templateUrl: './app.component.html',
  styleUrl: './app.component.css'
})
export class AppComponent {
  readonly title = signal('DropShield');
  readonly subtitle = signal('High-Concurrency Distributed Event Ticket Booking Platform');
  readonly phase = signal('Phase 02: Infrastructure Setup');
  readonly status = signal('Operational');

  readonly techStack = [
    { name: 'Angular 19+', role: 'Frontend & Reactive UI', status: 'Active' },
    { name: 'Node.js & Express', role: 'API Server & Middleware', status: 'Active' },
    { name: 'PostgreSQL 16', role: 'ACID Persistent Storage', status: 'Configured (Phase 2)' },
    { name: 'Redis 7', role: 'Atomic Lua Inventory Engine', status: 'Configured (Phase 2)' },
    { name: 'RabbitMQ 3.13', role: 'Durable Message Broker & Dashboard', status: 'Configured (Phase 2)' },
    { name: 'Docker Compose', role: 'Multi-Service Container Orchestration', status: 'Configured (Phase 2)' }
  ];
}
