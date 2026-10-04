# PharmaLink Ethiopia — Implementation Roadmap & Build Playbook

**Audience:** backend engineers, tech leads, DevOps.
**Purpose:** turn the approved 16-module design into a concrete, sequenced delivery plan. This is the *how and in what order to build*, complementing `00-architecture-index.md` (the *what*) and `00-shared-conventions.md` (the *rules*).

> Design phase is complete. The Prisma schema (`../backend/prisma/schema/`) validates. This document is the bridge to coding.

---

## 1. Guiding principles

- **Vertical slices, not horizontal layers.** Ship one module end-to-end (domain → application → infra → API → tests) before starting the next, so each phase produces a demoable capability.
- **Contracts first.** Within a module, define ports (interfaces), DTOs, and domain events before infrastructure. Cross-module calls go through ports + the domain-event catalog only — never direct table reads.
- **The schema is frozen per module at build start.** Schema changes after a module is "done" go through a migration + ADR, not ad-hoc edits.
- **Every module inherits the cross-cutting kit** (error envelope, `PermissionsGuard`, audit, outbox, config port) from Phase 0. Do not re-invent per module.

---

## 2. Repository & monolith assembly

Target backend layout (NestJS modular monolith, Clean Architecture per module):

```
backend/
  prisma/schema/            # DONE — single source of truth for DB
  src/
    main.ts
    app.module.ts           # imports all feature modules + shared
    shared/                 # cross-cutting kit (Phase 0)
      prisma/               # PrismaService (one client, injected everywhere)
      rbac/                 # PermissionsGuard, decorators, permission cache
      errors/               # error envelope, exception filter, error codes
      audit/                # hash-chained audit writer
      outbox/               # outbox writer + relay/dispatcher worker
      events/               # in-process event bus (typed) + contracts
      config/               # IConfigPort impl (DB-backed + env)
      crypto/               # envelope-encryption (KMS) helper
    modules/
      identity/             # domain/ application/ infrastructure/ interface/
      profiles/
      catalog/
      ... (one folder per module 01–16)
  test/                     # e2e + integration
```

**Rules**
- **One `PrismaClient`** (in `shared/prisma`), injected into every module's repositories. Do not instantiate per module.
- Each module folder follows the structure in its own design doc (§ "NestJS Folder Structure").
- Cross-module dependencies are wired via **ports registered in `shared/events`**, resolved through Nest DI. A module NEVER imports another module's repository.

---

## 3. Phase plan (with definition of done)

Sequencing follows `00-architecture-index.md` §2–3. Each phase below lists its epics and exit criteria.

### Phase 0 — Foundation (build first, everything depends on it)
**Modules:** 01 Identity → 02 Profiles → 13 Notifications (+ the `shared/` kit).

Epics:
1. **Shared kit**: PrismaService, error envelope + global exception filter, config port, in-process typed event bus, outbox writer + relay worker, hash-chained audit writer, envelope-encryption helper.
2. **01 Identity**: registration/login (phone + Fayda), sessions/refresh tokens, RBAC (roles, permissions, `PermissionsGuard`, Redis permission cache), OTP, verification requests, organizations, audit log.
3. **02 Profiles**: customer profiles, beneficiaries + `BeneficiaryAccessPolicy`, addresses, notification-category preferences, consents.
4. **13 Notifications**: template engine, channel preferences + quiet hours, provider adapters (SMS/push/email behind ports), BullMQ delivery workers, suppression list, delivery-attempt tracking.

**Exit criteria (DoD):** a user can register, verify, log in, manage profile/beneficiaries, and receive a templated multi-channel notification. RBAC guard enforced on a sample protected route. Audit entries hash-chain verified by a test.

### Phase 1 — Pharmacy Marketplace MVP (the core revenue flow)
**Modules:** 03 Catalog → 04 Pharmacy/Inventory → 05 Prescription/Matching → 06 Orders → 07 Payment → 08 Delivery.
Plus **minimal** 14 Search (Postgres FTS over catalog/pharmacy) and **minimal** 16 Admin (verification approvals for pharmacies, product proposals).

Epics (in order):
1. **03 Catalog** — product master, classification (Rx/OTC/controlled), categories, equivalence, proposals; emits `catalog.product.*` events.
2. **04 Pharmacy/Inventory** — pharmacy/branch onboarding + verification, listings, stock ledger (batches, movements), **reservation/hold + TTL**, availability engine; emits stock/availability events.
3. **05 Prescription/Matching** — prescription upload (encrypted), pharmacist verification, dispensing ledger, pharmacy matching against availability.
4. **06 Orders** — cart, **checkout saga orchestrator** (Rx gate → reserve stock → pay → create delivery), order lifecycle, fulfillments, invoices, outbox.
5. **07 Payment** — double-entry ledger (single money authority), payment gateway adapters (Telebirr/bank/card), refunds, coupons, settlements, provider webhooks, fraud flags.
6. **08 Delivery** — driver onboarding, job creation, dispatch/offer, real-time tracking (WebSocket + Redis pub/sub), proof-of-delivery, COD collection, earnings ledger.

**Exit criteria (DoD):** end-to-end happy path — browse → add to cart → (Rx verify if needed) → checkout → pay → assign driver → deliver → PoD → settle. Saga compensation tested (payment failure releases stock reservation). Ledger balances reconcile in a test.

### Phase 2 — Healthcare Services
**Modules:** 09 Provider Directory → 10 Doctor/Appointment → 11 Diagnostics → 12 Consultation/Records.

Epics:
1. **09 Provider Directory** — providers/locations/departments/service offerings + verification; eligibility policy.
2. **10 Doctor/Appointment** — doctor profiles, availability rules → **materialized slots**, slot hold + TTL, booking (reuses checkout saga + 07 payment), reschedule/cancel/waitlist.
3. **11 Diagnostics** — bookings (at-center capacity slots + home collection), results (versioned, encrypted), analytes; results feed 12 records.
4. **12 Consultation/Records** — telemedicine sessions (SFU adapter), notes, e-prescriptions, **health-records vault** (aggregation index over 05/11 + notes), consent + access log, data-rights (export/delete).

**Exit criteria (DoD):** patient books & pays for an appointment, completes a telemedicine consult, receives an e-prescription that appears in the records vault; a diagnostic result is issued, encrypted, and access-logged with consent enforcement.

### Phase 3 — Growth & Optimization
**Modules:** 14 Search (mature), 15 Reviews, 16 Admin (mature).

Epics:
1. **14 Search** — full CQRS projections from 03/04/09/10/15 via events; geo + typo-tolerant ranking; OpenSearch migration behind `ISearchEngine` when scale requires.
2. **15 Reviews** — verified-transaction reviews, moderation workflow, async rating aggregates feeding 14 + provider/pharmacy/doctor metrics.
3. **16 Admin** — full control plane: maker-checker approvals across all modules, support tickets, feature flags, system config, announcements, dashboard metrics, read-only audit-log viewer.

**Exit criteria (DoD):** unified search returns ranked cross-entity results; a completed order/appointment yields a moderatable review that updates aggregates; admin can approve/reject via maker-checker with full audit trail.

---

## 4. Database migration & seed strategy

1. **Baseline migration.** With `DATABASE_URL` set, run `npm run prisma:migrate -- --name init` to generate the first migration from the current schema folder. Commit `prisma/migrations/`.
2. **Raw-SQL follow-ups** (not expressible in Prisma) go in dedicated migrations *after* baseline:
   - `tsvector` columns + GIN indexes for Module 14 FTS.
   - PostGIS geography columns/indexes (or `pg_trgm`) if adopted for geo search.
   - The hash-chain trigger/constraint for `audit_logs` (if enforced in DB).
   - Partial/covering indexes noted in each module's DB-design section.
3. **Seed reference data** (`prisma/seed.ts`, idempotent, environment-aware):
   - System roles + permission catalog (Module 01).
   - Default `system_configs` + `feature_flags` (Module 16).
   - Notification templates (Module 13) for the Phase-0/1 events.
   - Product categories + a small catalog sample (Module 03) for dev/demo.
4. **Never seed** real health data, card data, or production secrets. Dev seeds use synthetic data only.

---

## 5. Testing strategy (per module, gate for DoD)

- **Domain unit tests** — invariants and value objects (no DB). Highest coverage here.
- **Application/use-case tests** — ports mocked; verify orchestration + emitted events.
- **Integration tests** — repositories against a real Postgres (Testcontainers or ephemeral DB); verify Prisma mappings, ledgers, reservations, unique constraints.
- **E2E tests** — key flows per phase (auth, checkout saga + compensation, appointment booking, results access-control).
- **Contract tests** — every emitted domain event validated against `00-domain-event-catalog.md`; consumers tested against those contracts.
- **Security tests** — RBAC scope enforcement, beneficiary access policy, encrypted-field non-leakage, audit-chain integrity.

Do not weaken or delete tests to make a build pass; fix the root cause.

---

## 6. Cross-cutting engineering checklist (applies to every module)

- [ ] All responses use the standard error envelope; errors mapped to catalog codes.
- [ ] Every mutating endpoint is permission-guarded (`resource:action[:scope]`).
- [ ] Privileged/mutating actions write a hash-chained audit entry.
- [ ] State changes that others care about are published via the **outbox** (never dual-write).
- [ ] Money is integer minor units + currency; balances derived from append-only ledgers.
- [ ] Health/PII artifacts stored as `*Ref` (encrypted); never logged in plaintext.
- [ ] Tunable parameters read from `IConfigPort`, not hard-coded.
- [ ] Amharic + English supported for user-facing content.
- [ ] Idempotency keys on payment/webhook/booking mutations.

---

## 7. Environment configuration reference

`.env` is gitignored, so it is documented here (see `../backend/README.md` for the DB URL). Provision per environment:

| Variable | Purpose | Phase needed |
| --- | --- | --- |
| `DATABASE_URL` | PostgreSQL connection | 0 |
| `REDIS_URL` | cache, queues (BullMQ), pub/sub, sessions/OTP | 0 |
| `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` | token signing | 0 |
| `KMS_KEY_ID` / `KMS_ENDPOINT` | envelope encryption for health/PII | 0 (helper), 1/2 (usage) |
| `FAYDA_CLIENT_ID` / `FAYDA_CLIENT_SECRET` / `FAYDA_BASE_URL` | national ID verification | 0 |
| `SMS_GATEWAY_*` | SMS provider (ET + intl) | 0 |
| `FCM_*` | push notifications | 0 |
| `EMAIL_PROVIDER_*` | transactional email | 0 |
| `TELEBIRR_*` / `BANK_GATEWAY_*` / `CARD_GATEWAY_*` | payment gateways | 1 |
| `MEDIA_SFU_*` (LiveKit/Twilio) | telemedicine media | 2 |
| `MAPS_API_KEY` / `ROUTING_API_KEY` | delivery geo/routing | 1 |
| `OPENSEARCH_URL` (optional) | search at scale | 3 |
| `STORAGE_BUCKET` / `STORAGE_*` | encrypted artifact storage | 1 |
| `ORDERS_PLATFORM_FEE_PERCENT` | platform commission, as a **fraction** (`0.05` = 5%); optional, defaults to `0`. Validated at boot to 0–1, because a wrong value here mis-prices every order rather than disabling a feature. Backs the `orders.platformFeePercent` config key that `PricingCalculator` multiplies by the subtotal — note the fee is charged on the **pre-discount** subtotal, so a platform-funded coupon (ADR-019) never reduces it. | 1 |

Never commit secrets. Use a secrets manager in staging/production.

---

## 8. Definition of "ready to start coding"

- [x] 16 module design docs approved.
- [x] Shared conventions + domain-event catalog published.
- [x] Prisma schema validates (`prisma validate` green).
- [x] Build playbook + phase DoD defined (this doc).
- [x] Key decisions recorded (`00-decision-log.md`).
- [ ] Open questions in `00-architecture-index.md` §7 answered by Product/Compliance (can proceed on Phase 0 in parallel — none block Identity/Profiles/Notifications).

**Recommendation:** begin **Phase 0** now. It is unblocked by every open question. Resolve the compliance/regulatory open questions before Phase 1 controlled-substance and payment work.

---

*End of implementation roadmap.*
