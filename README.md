# PharmaLink Ethiopia — Digital Healthcare Marketplace

PharmaLink is a digital healthcare marketplace for Ethiopia: order medicines from verified pharmacies, upload and fill prescriptions, book doctor appointments and telemedicine consults, schedule lab/diagnostic tests, and keep a personal health-records vault — with Amharic + English throughout.

This repository holds the **product, architecture, database, and client prototypes**. The backend application code has not been written yet; the design phase is complete and implementation-ready.

---

## Repository map

| Folder | Contents | Status |
| --- | --- | --- |
| `bussiness analysis/` | Business analysis, requirements, market/domain research | Reference |
| `architecture/` | 16 module design docs + consolidation docs (index, conventions, events, roadmap, decisions) | **Complete** |
| `backend/` | Prisma schema (single source of truth for the DB) + setup docs | **Schema complete & validated** |
| `app/` | Customer-facing web prototype — React + Vite + Tailwind + framer-motion | Prototype |
| `web/` | Pharmacy Portal + Admin/Super-Admin dashboards — React + Vite + MUI + react-query | Prototype |
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

```bash
cd backend
npm install
# create .env with DATABASE_URL (see backend/README.md)
npm run prisma:validate
npm run prisma:format
npm run prisma:migrate -- --name init   # generates the baseline migration
```

Details, conventions, and shared-table notes: `backend/README.md`.

---

## Status & next step

- Design phase: **complete** (16 module docs + 5 consolidation docs).
- Database schema: **complete and validated**.
- **Recommended next step:** begin **Phase 0** (shared kit + Identity + Profiles + Notifications) per `architecture/00-implementation-roadmap.md`. Phase 0 is unblocked by all outstanding product/compliance questions.

---

*PharmaLink Ethiopia — building accessible healthcare, one verified transaction at a time.*
