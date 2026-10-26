# PharmaLink Backend

The PharmaLink Ethiopia backend: a NestJS modular monolith (`src/`) with a Prisma data layer (`prisma/schema/`) covering all 16 modules described in `../architecture/`.

## What is implemented

Ten feature modules are registered in `src/app.module.ts`, alongside the shared kit (`src/shared/`: config, logging, Prisma, crypto, events, outbox, audit, RBAC, errors, Redis) and health checks:

| Module | Folder |
|---|---|
| 01 Identity & authentication | `src/modules/identity` |
| 02 Profiles | `src/modules/profiles` |
| 03 Catalog | `src/modules/catalog` |
| 04 Pharmacy & inventory | `src/modules/pharmacy-inventory` |
| 05 Prescription & matching | `src/modules/prescription-matching` |
| 06 Orders | `src/modules/orders` |
| 07 Payment | `src/modules/payment` |
| 08 Delivery | `src/modules/delivery` |
| 13 Notifications | `src/modules/notifications` |
| 16 Admin | `src/modules/admin` |

Modules **09 Providers, 10 Appointments, 11 Diagnostics, 12 Consultation, 14 Search and 15 Reviews have schema definitions only**: their tables exist, but there is no feature module, controller or workflow for them. A table in the schema is not evidence that a feature exists.

Several implemented workflows still run on development stand-ins rather than real integrations:

| Area | Current adapter |
|---|---|
| OTP | In-memory; the code is written to the log, not sent, and is lost on restart |
| SMS | Not configured; SMS deliveries are never sent |
| Fayda identity verification | Mock that approves any well-formed id, selected by `IDENTITY_VERIFICATION_PROVIDER` (default `mock` outside production). Production requires `fayda`, which fails at startup until a real adapter exists ([runtime-identity-verification.md](docs/runtime-identity-verification.md)) |
| Payments | Mock provider approves gateway methods in-process; the Telebirr adapter is deliberately unimplemented |
| Proof-of-delivery artifacts | In-memory storage, lost on restart |
| Routing / ETA | Straight-line (haversine) distance |
| E-mail, push | Resend and FCM adapters, active only when their variables are set |

Because OTP codes, proof-of-delivery artifacts and the in-process event bus live in memory, run **exactly one** backend instance until those adapters are replaced.

## Layout

The schema uses Prisma's **multi-file schema folder** (`prisma/schema/`), one file per module, mirroring the modular-monolith architecture:

```
prisma/schema/
  00-config.prisma        # datasource + generator
  01-identity.prisma      # users, roles, RBAC, sessions, verification, audit
  02-profiles.prisma      # customer profiles, beneficiaries, addresses, preferences, consents
  03-catalog.prisma       # product master, categories, equivalence
  04-pharmacy.prisma      # pharmacies, branches, listings, stock ledger, reservations
  05-prescription.prisma  # prescriptions, verification, dispensing ledger, matching
  06-orders.prisma        # cart, orders, fulfillments, invoices, outbox
  07-payment.prisma       # double-entry ledger, payments, refunds, coupons, settlements
  08-delivery.prisma      # driver profiles, jobs, dispatch, PoD, earnings, COD
  09-provider.prisma      # hospitals/clinics/labs, locations, departments, service offerings
  10-appointment.prisma   # doctors, availability, slots, appointments, waitlist
  11-diagnostics.prisma   # diagnostic bookings, home collection, results
  12-consultation.prisma  # telemedicine sessions, e-prescriptions, records vault, consent
  13-notifications.prisma # notifications, deliveries, templates, device tokens
  14-search.prisma        # search read-model projections (CQRS)
  15-reviews.prisma       # verified-transaction reviews, aggregates, moderation
  16-admin.prisma         # platform config, feature flags, disputes, approvals
```

## Requirements

- **Node.js 22** and **PostgreSQL 16**: the versions CI verifies (`.github/workflows/backend-ci.yml` and the e2e harness's `postgres:16` container). Prisma 6 (local dev dependency).
- Redis 7 is optional: without `REDIS_URL` the app boots and serves every route, with live-tracking fan-out limited to a single process.
- Vanilla Postgres is enough; geo is modelled as `lat`/`lng` floats plus a `geohash` string.

## Configuration

The application validates its environment at boot and refuses to start on a missing or invalid value. The source of truth is `src/shared/config/env.validation.ts` (plus `app-config.service.ts` for the optional token and OTP lifetimes, and each integration's `*.config.ts`). Required:

| Variable | Requirement |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string |
| `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` | At least 16 characters each |
| `MASTER_ENCRYPTION_KEY` | Base64 of exactly 32 random bytes (`node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`) |

`IDENTITY_VERIFICATION_PROVIDER` (`mock` | `fayda`) is optional outside production (default `mock`) and **required in production**, where only `fayda` is accepted; see [docs/runtime-identity-verification.md](docs/runtime-identity-verification.md).

Everything else is optional with validated defaults (`NODE_ENV`, `PORT`, `WEB_ORIGIN`, `ORDERS_PLATFORM_FEE_PERCENT`, `REDIS_*`, the `DELIVERY_*` families) or integration-specific (`RESEND_*`, `FCM_*`, `TELEBIRR_*`). Never commit `.env` or real credentials. `NODE_ENV=test` disables the background jobs and is for the test suites only.

## Clean install (new, empty database)

Migrations are **committed** in `prisma/schema/migrations/`. Apply them in order; never generate a new baseline migration (`prisma migrate dev --name init`) against a shared database.

```bash
npm ci
npx prisma generate              # required before build or tests
npx prisma migrate deploy        # applies every committed migration in order
npm run prisma:seed              # 14 roles + the permission catalog; idempotent, creates no users
npm run build                    # nest build -> dist/
npm run start:prod               # node dist/main.js
```

Health checks: `GET /health/live` (no database access) and `GET /health/ready` (pings PostgreSQL). There is no global route prefix.

Upgrading a database that **already holds data or migration history** is a different procedure: follow `../ops/predeploy/README.md` before running the newer migrations.

## Tests

```bash
npm test             # unit tests
npm run test:e2e     # e2e: starts disposable Postgres + Redis containers via testcontainers (Docker required)
```

CI runs both, plus type-checking and ESLint. Passing CI is not production readiness: it does not exercise real integrations, deployment packaging, backups or a production-mode boot.

## Design conventions

See `../architecture/00-shared-conventions.md` §11 (Data & Persistence). Highlights:

- **Cross-module references are scalar UUID fields** (e.g., `catalogProductId String`) with **no** Prisma relation, deliberately — this preserves bounded-context boundaries and makes future extraction to microservices clean. Referential integrity for these is enforced in the application layer / via events. Relations are declared only **within** a module.
- **Money** is always `Int` minor units + a `currency` string.
- **Encrypted fields** store storage/key references only (`*Ref`), never plaintext health data or card data.
- **Append-only ledgers** (`stock_movements`, `ledger_entries`, `dispense_records`, `driver_earnings`, `audit_logs`) are the sources of truth; cached balances are rebuildable.
- **Materialized search views** from Modules 3/9 are consolidated into Module 14's projection tables (`*_search_docs`); the per-module views are DB materialized views, not Prisma models.

## Notes on shared tables

- `consents` (Module 01) is shared with Module 02 (health-consent types added to the enum).
- **Notification preferences have one owner: Module 13** (decided in Module 13 Work 11).
  - `channel_preferences` (model `ChannelPreference`, enums `MessageCategory` × `NotificationChannel`, plus `DigestFrequency`) is the single source of truth, read and written only by Module 13 (`/notification-preferences`).
  - `notification_preferences` (model `NotificationPreference`, enum `NotificationCategory`) is **deprecated**: no code ever used it, its categories do not match the notification templates, and it has no in-app channel or digest. It is left in place for a later migration to drop.
  - Module 02 keeps profile data; the language a notification is rendered in is Module 01's `preferredLanguage`, read through its language port.
- `outbox` is defined once (Module 06) and reused by all event-publishing modules.

## E-mail notifications (Resend)

Module 13 sends e-mail through [Resend](https://resend.com) over its REST API (`POST https://api.resend.com/emails`), plain text only. Two settings, both required, both secret-handled through the normal config port (never logged, never stored):

| Variable | Meaning |
| --- | --- |
| `RESEND_API_KEY` | Resend API key with sending access |
| `RESEND_FROM_EMAIL` | Sender on a domain verified in Resend, e.g. `PharmaLink <alerts@your-domain>` |

With either unset — and always under `NODE_ENV=test` — the e-mail provider is not registered and EMAIL delivery jobs wait `PENDING` (no attempts, no retries used). Automated tests never call Resend.

**Manual smoke test (sends one real e-mail; opt-in only):**

```bash
RESEND_API_KEY=... RESEND_FROM_EMAIL="PharmaLink <alerts@your-domain>" RESEND_SMOKE_TO=you@your-inbox npx ts-node test/manual/resend-smoke.ts
```

Use your own inbox, never a customer address. It sends the ACCOUNT_REACTIVATED text and prints only the outcome, the Resend message id and a masked recipient. Add `RESEND_SMOKE_LANG=am` for the Amharic rendering.
