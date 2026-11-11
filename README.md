# 🛡️ DropShield

> **DropShield** is a distributed event ticket booking platform designed to manage high-demand flash crowd booking traffic without overselling, race conditions, or database degradation.

---

## 🏗️ Architecture Overview

DropShield employs a multi-tiered architecture with in-memory reservation and asynchronous persistent processing:

```mermaid
flowchart TD
    Client["Angular 19+ Client"] -->|HTTP / REST| API["Express.js API Gateway"]
    API -->|Atomic Decr / Lua Script| Redis[("Redis 7 Inventory Engine\nTTL Leases & Idempotency")]
    API -->|Durable Publish| RMQ["RabbitMQ 3.13 Message Broker"]
    RMQ -->|Asynchronous Consume| Worker["Background Worker Process"]
    Worker -->|ACID Transaction| DB[("PostgreSQL 16\nConfirmed Bookings")]
    Worker -->|Reconciliation / Events| Redis
```

### Architectural Principles
- **In-Memory Fast Path**: Ticket reservations are claimed atomically in Redis before touching the relational database.
- **Asynchronous Order Processing**: RabbitMQ buffers booking events to ensure a predictable, steady write workload on PostgreSQL.
- **Zero-Overselling Guarantee**: Enforced by atomic inventory decrements, monotonic sequence checks, and database constraints.
- **Idempotency**: Requests carry idempotency keys ensuring at-most-once reservation semantics even under network retries.

---

## 🛠️ Technology Stack

| Layer | Technology | Purpose |
| :--- | :--- | :--- |
| **Frontend** | Angular 19+, TypeScript, RxJS | Reactive user booking interface |
| **Styling** | Tailwind CSS | Modern, utility-first responsive styling |
| **Backend API** | Node.js, Express.js, TypeScript | REST API gateway |
| **Validation** | Zod | Runtime environment variable and payload schema validation |
| **Database** | PostgreSQL 16 (`pg` driver) | ACID persistent relational storage |
| **Cache & Engine** | Redis 7 + Lua Scripts | In-memory inventory engine, distributed locks, TTL leases |
| **Message Broker**| RabbitMQ 3.13 (Management) | Durable, asynchronous message broker with monitoring dashboard |
| **Testing** | Jest, Supertest | Unit, integration, and endpoint testing |
| **Infrastructure**| Docker, Docker Compose | Isolated multi-container environment |

---

## 📂 Repository Structure

DropShield is organized as an **npm workspaces monorepo**:

```
DropShield/
|-- frontend/                 # Angular 19+ Single Page Application
|   |-- src/                  # App components, styles, configurations
|   |-- angular.json          # Angular CLI workspace configuration
|   |-- package.json          # Frontend dependencies & scripts
|   |-- tsconfig.json         # Strict TypeScript compiler options
|
|-- backend/                  # Node.js + Express API & Background Worker
|   |-- src/
|   |   |-- config/           # Zod environment validation & runtime config
|   |   |-- middleware/       # Error handling, request logging
|   |   |-- routes/           # REST endpoints (e.g. /health)
|   |   |-- services/         # Domain business logic (Phase 4 & 5)
|   |   |-- queues/           # RabbitMQ publishers & consumers (Phase 5)
|   |   |-- utils/            # Structured logging and utilities
|   |   |-- app.ts            # Express application factory
|   |   |-- server.ts         # API Server entry point
|   |   |-- worker.ts         # Background Worker entry point
|   |-- tests/                # Jest & Supertest integration tests
|   |-- package.json          # Backend dependencies & scripts
|   |-- tsconfig.json         # Strict TypeScript configuration
|
|-- shared/                   # Cross-workspace TypeScript contracts
|   |-- src/                  # Shared domain types, contracts & constants
|   |-- types/                # Type definitions
|   |-- package.json          # Workspace package configuration
|   |-- tsconfig.json         # Declaration and compiler settings
|
|-- database/                 # Database schema evolution (Phase 3)
|   |-- migrations/           # SQL migration scripts
|   |-- seeds/                # Seed data for development and testing
|
|-- infrastructure/           # Docker and deployment configurations
|   |-- docker/               # Service Dockerfiles
|
|-- scripts/                  # Development and CI/CD utility scripts
|-- docs/                     # Architectural documents & design specs
|-- docker-compose.yml        # Multi-container orchestration (Postgres, Redis, RabbitMQ)
|-- package.json              # Monorepo root workspace manifest
|-- .gitignore                # Git ignore rules (secrets, dist, node_modules)
|-- .env.example              # Documented environment template
|-- .editorconfig             # Consistent editor formatting rules
|-- README.md                 # Project documentation
```

---

## 🗺️ Development Roadmap

- [x] **Phase 01: Repository & Monorepo Setup** (Workspace, Angular 19, Express, TypeScript, Git configuration)
- [x] **Phase 02: Infrastructure Setup** (PostgreSQL, Redis, RabbitMQ, Docker Compose)
- [ ] **Phase 03: Database Engineering** (Migrations, schema, indexes, transactional constraints)
- [ ] **Phase 04: Redis Inventory Engine** (Lua scripts, atomic reservations, TTL and idempotency)
- [ ] **Phase 05: Backend Processing** (API intake, RabbitMQ, background workers)
- [ ] **Phase 06: Authentication & Frontend** (RBAC, JWT cookies, Angular booking interface)
- [ ] **Phase 07: Reliability Engineering** (Retries, recovery, failure injection and reconciliation)
- [ ] **Phase 08: Performance Engineering** (k6, experiments, Prometheus and Grafana)

---

## 🐳 Infrastructure & Local Development

DropShield uses **Docker Compose** to provision and orchestrate local infrastructure services with strict isolation and health monitoring.

### Prerequisites
- **Node.js**: `v20.11.0` or higher (Active LTS recommended)
- **npm**: `v10.0.0` or higher
- **Docker Desktop** (or Docker Engine 24+) with the Docker Compose plugin

### Environment Configuration
Copy `.env.example` to create your local `.env` file:

```bash
# On Linux/macOS
cp .env.example .env

# On Windows PowerShell
Copy-Item .env.example .env
```

### Starting the Infrastructure
Start all core infrastructure containers in detached mode:

```bash
npm run infra:up
# Equivalent to: docker compose up -d
```

### Stopping the Infrastructure
Stop containers while **preserving** persistent volume data:

```bash
npm run infra:down
# Equivalent to: docker compose down
```

### Inspecting Infrastructure Health & Logs
```bash
# View real-time container status and health checks
npm run infra:ps

# Stream live multi-service logs
npm run infra:logs
```

---

## 🔌 Local Service Endpoints & Connection Details

All ports are bound exclusively to `127.0.0.1` to prevent unauthorized external network exposure:

| Service | Container Name | Host Port | Internal Port | Protocol | Default Credentials | Connection String |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **PostgreSQL 16** | `dropshield-postgres` | `5432` | `5432` | TCP / PostgreSQL | `postgres` / `postgres` | `postgresql://postgres:postgres@localhost:5432/dropshield` |
| **Redis 7 (AOF)** | `dropshield-redis` | `6379` | `6379` | Redis TCP | *(None / dev default)* | `redis://localhost:6379` |
| **RabbitMQ AMQP** | `dropshield-rabbitmq` | `5672` | `5672` | AMQP 0-9-1 | `guest` / `guest` | `amqp://guest:guest@localhost:5672` |
| **RabbitMQ UI** | `dropshield-rabbitmq` | `15672` | `15672` | HTTP | `guest` / `guest` | `http://localhost:15672` |

### RabbitMQ Management Dashboard
Open [http://localhost:15672](http://localhost:15672) in your browser:
- **Username**: `guest`
- **Password**: `guest`

Use this console to monitor connection pools, exchanges, message queue depth, and consumer acknowledgements.

---

## ⚠️ Resetting Development Data

> [!CAUTION]
> **Data Destruction Warning**: Resetting volumes deletes all persisted database rows, Redis cache entries, and RabbitMQ queues permanently. Never run this on a production system.

To completely reset all local development data and re-initialize empty volumes:

```bash
# Stop containers and remove named volumes
docker compose down -v
```

Persistent named volumes managed by Compose:
- `dropshield_postgres_data` (maps to `/var/lib/postgresql/data`)
- `dropshield_redis_data` (maps to `/data`)
- `dropshield_rabbitmq_data` (maps to `/var/lib/rabbitmq`)

---

## 💻 Application Scripts

All development and test commands can be executed from the root directory:

```bash
# Install all workspace dependencies
npm install

# Run the Frontend (Angular 19 on http://localhost:4200)
npm run dev:frontend

# Run the Backend API (Express on http://localhost:4000)
npm run dev:backend

# Run the Asynchronous Background Worker
npm run dev:worker

# Build all monorepo workspaces (shared -> backend -> frontend)
npm run build

# Run unit & integration tests
npm test

# Run ESLint across codebases
npm run lint

# Format code with Prettier
npm run format
```

---

## 🔍 Health Check Verification

The backend provides health check endpoints for operational probes:

- `GET http://localhost:4000/health`
- `GET http://localhost:4000/api/health`

**Sample Response:**
```json
{
  "status": "healthy",
  "uptime": 124,
  "timestamp": "2026-11-11T08:30:00.000Z",
  "environment": "development",
  "version": "1.0.0",
  "services": {
    "database": "up",
    "redis": "up",
    "rabbitmq": "up"
  }
}
```

---

## 🛡️ License
MIT License. Copyright © 2026 DropShield Contributors.
