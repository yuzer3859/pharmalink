# PharmaLink Ethiopia — Digital Healthcare Marketplace

PharmaLink is a digital healthcare marketplace for Ethiopia: order medicines from verified pharmacies, upload and fill prescriptions, book doctor appointments and telemedicine consults, schedule lab/diagnostic tests, and keep a personal health-records vault — with Amharic + English throughout.

This repository holds the product and architecture documents, the NestJS backend, and two web front-end prototypes. **The backend is implemented for 10 of the 16 planned modules** (01 Identity, 02 Profiles, 03 Catalog, 04 Pharmacy inventory, 05 Prescription matching, 06 Orders, 07 Payment, 08 Delivery, 13 Notifications, 16 Admin), all registered in `backend/src/app.module.ts`. Modules 09 Providers, 10 Appointments, 11 Diagnostics, 12 Consultation, 14 Search and 15 Reviews have database schema definitions only, with no feature module. PharmaLink has not been deployed.

---

## Repository map

| Folder | Contents | Status |
| --- | --- | --- |
| `bussiness analysis/` | Business analysis, requirements, market/domain research | Reference |
| `architecture/` | 16 module design docs + consolidation docs (index, conventions, events, roadmap, decisions) | **Complete** |
| `backend/` | NestJS backend, Prisma schema and committed migrations | 10 of 16 modules implemented; see `backend/README.md` |
| `app/` | Customer-facing web prototype — React + Vite + Tailwind + framer-motion | Prototype; mock data only, no backend calls |
| `web/` | Pharmacy Portal + Admin/Super-Admin dashboards — React + Vite + MUI + react-query | Prototype; login calls the backend, other screens use mock data |
| `ops/predeploy/` | Pre-deployment read-only data checks and operator runbook | Reviewed |
| `qa/` | QA artifacts | Reference |

> **Note on client stack:** the architecture index lists a target stack (e.g., Flutter for mobile). The current prototypes in `app/` and `web/` are React/Vite. Treat the mobile-framework choice as an open product decision; the backend contracts are client-agnostic.

---

## Where to start (by role)

- **Product / Compliance:** read `architecture/00-architecture-index.md` (§7 open questions need your answers) and the relevant module docs.
- **Backend engineers:** read in this order —
  1. `architecture/00-architecture-index.md` — the map (modules, phases, dependencies).
  2. `architecture/00-shared-conventions.md` — the rules every module follows.
  3. `architecture/00-domain-event-catalog.md` — inter-module contracts.
  4. `architecture/00-implementation-roadmap.md` — **the build playbook: what to build, in what order, and the definition of done.**
  5. `architecture/00-decision-log.md` — why key decisions were made.
  6. Your module's `module-NN-*.md`, then its `backend/prisma/schema/NN-*.prisma`.
- **DBAs / DevOps:** `backend/README.md` + roadmap §4 (migrations/seed) and §7 (env config).

---

## Architecture at a glance

- **Style:** Modular monolith (NestJS) · Clean Architecture · DDD · SOLID · CQRS-ready.
- **16 bounded-context modules**, built in 4 phases: Foundation → Pharmacy Marketplace MVP → Healthcare Services → Growth & Optimization.
- **Persistence:** PostgreSQL via Prisma (multi-file schema folder), Redis (cache/queue/realtime), encrypted cloud storage for health artifacts.
- **Key patterns:** scalar cross-module UUID refs (no cross-context FKs), integer-minor-unit money, append-only ledgers with derived balances, reservation+TTL for scarce resources, checkout/booking sagas with compensation, outbox eventing, hash-chained audit log, envelope-encrypted health data.

See `architecture/00-decision-log.md` for the reasoning behind each of these.

---

## Database (backend)

The Prisma schema is the single source of truth, one file per module under `backend/prisma/schema/`. It **validates cleanly on Prisma 6**.

Migrations are **committed** under `backend/prisma/schema/migrations/`. Apply them; never generate a new baseline (`--name init`) migration:

```bash
cd backend
npm ci
# create .env (see backend/README.md and src/shared/config/env.validation.ts)
npx prisma generate
npx prisma migrate deploy
npm run prisma:seed          # roles and permissions only; idempotent
```

Clean-install details, conventions and shared-table notes: `backend/README.md`. Before upgrading a database that already holds data, follow `ops/predeploy/README.md`.

---

## Status

- Design: 16 module docs + 5 consolidation docs.
- Backend: 10 of 16 modules implemented; 6 have schema only.
- **CI** (`.github/workflows/backend-ci.yml`) runs on pull requests to `main`, pushes to `main` and manual dispatch: type-check and lint, all unit tests, and all e2e tests against a disposable PostgreSQL 16 started by testcontainers, on Node 22.
- **Passing CI is not production readiness.** Several integrations are still development stand-ins (in-memory OTP that logs codes, mock Fayda verification, mock payment provider, in-memory proof-of-delivery storage, no SMS provider), there is no deployment packaging yet, and the front ends are prototypes.

---

*PharmaLink Ethiopia — building accessible healthcare, one verified transaction at a time.*
