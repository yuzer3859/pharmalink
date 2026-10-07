# PharmaLink Backend — Data Layer (Prisma)

This package holds the **consolidated Prisma schema** for PharmaLink Ethiopia — the single source of truth for the database across all 16 modules described in `../architecture/`.

> Scope: **data layer only** (schema, enums, relations). The NestJS application code is not part of this package yet.

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

- **Prisma >= 6** (multi-file schema folder is GA). Node 18+.
- PostgreSQL 14+ (PostGIS/pg_trgm recommended for Module 14 search, but the base schema models geo as `lat`/`lng` floats + `geohash` string so it runs on vanilla Postgres).

## Setup

1. Install deps:
   ```bash
   npm install
   ```
2. Create a `.env` file in `backend/` (gitignored) with your database URL:
   ```
   DATABASE_URL="postgresql://USER:PASSWORD@localhost:5432/pharmalink?schema=public"
   ```
3. Validate & format the schema:
   ```bash
   npm run prisma:validate
   npm run prisma:format
   ```
4. Generate the client / create the first migration:
   ```bash
   npm run prisma:generate
   npm run prisma:migrate -- --name init
   ```

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
