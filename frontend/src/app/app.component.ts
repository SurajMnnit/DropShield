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
  readonly phase = signal('Phase 01: Repository & Monorepo Setup');
  readonly status = signal('Operational');

  readonly techStack = [
    { name: 'Angular 19+', role: 'Frontend & Reactive UI', status: 'Initialized' },
    { name: 'Node.js & Express', role: 'API Server & Middleware', status: 'Initialized' },
    { name: 'PostgreSQL', role: 'ACID Persistent Storage', status: 'Ready (Phase 2)' },
    { name: 'Redis', role: 'Atomic Lua Inventory Cache', status: 'Ready (Phase 2)' },
    { name: 'RabbitMQ', role: 'Durable Message Broker', status: 'Ready (Phase 2)' },
    { name: 'TypeScript', role: 'Strict Monorepo Contracts', status: 'Configured' }
  ];
}
