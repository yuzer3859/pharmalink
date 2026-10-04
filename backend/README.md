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
- **Notification preferences are split by concern (Prisma merges all files into one global namespace, so names must be unique):**
  - `notification_preferences` + enum `NotificationCategory` are owned by **Module 02** — the profile-level, category toggles a user sees in settings (push/sms/email booleans per category).
  - `channel_preferences` (model `ChannelPreference`) + enum `MessageCategory` are owned by **Module 13** — the delivery engine's per-channel routing/opt-in and digest cadence. Module 13 also honors Module 02's toggles at send time.
- `outbox` is defined once (Module 06) and reused by all event-publishing modules.
