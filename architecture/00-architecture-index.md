# PharmaLink Ethiopia — Architecture Index

**Product:** PharmaLink Ethiopia — Digital Healthcare Marketplace
**Architecture style:** Modular Monolith (NestJS) · Clean Architecture · DDD · SOLID · CQRS-ready
**Persistence:** PostgreSQL (Prisma) · Redis (cache/queue/realtime) · Cloud Storage (encrypted artifacts)
**Clients:** Customer (Flutter), Driver (Flutter), Pharmacy/Provider (React), Admin (React)
**Status:** Design phase complete — 16 module design docs + 5 consolidation docs published; Prisma schema built & validated. Ready to begin Phase 0 implementation (see `00-implementation-roadmap.md`).

> This is the master index for the PharmaLink architecture. Each module has a dedicated design document (single source of truth for its bounded context). This index provides the map: modules, phases, dependencies, and shared conventions.

---

## 1. Module Catalog

| # | Module | Doc | Bounded Context Owns |
| --- | --- | --- | --- |
| 01 | Identity & Authentication | `module-01-identity-authentication.md` | Users, roles/RBAC, sessions, verification, audit log, organizations |
| 02 | User & Profile Management | `module-02-user-profile.md` | Customer profiles, beneficiaries, addresses, preferences, guardianships, consents |
| 03 | Catalog | `module-03-catalog.md` | Canonical product master, Rx/OTC + controlled classification, categories, equivalence |
| 04 | Pharmacy & Inventory | `module-04-pharmacy-inventory.md` | Pharmacies, branches, listings, stock ledger, batches, reservations, availability |
| 05 | Prescription & Matching | `module-05-prescription-matching.md` | Prescriptions, pharmacist verification, dispensing ledger, pharmacy matching |
| 06 | Cart, Checkout & Orders | `module-06-cart-checkout-orders.md` | Cart, checkout saga, order lifecycle, fulfillments, invoices |
| 07 | Payment, Wallet & Settlement | `module-07-payment-wallet.md` | Double-entry ledger, payments, refunds, wallet, coupons, settlements |
| 08 | Delivery & Tracking | `module-08-delivery-tracking.md` | Delivery jobs, driver dispatch, real-time tracking, PoD, earnings, COD |
| 09 | Provider Directory | `module-09-provider-directory.md` | Hospitals/clinics/diagnostic centers/labs, locations, departments, service offerings |
| 10 | Doctor & Appointment | `module-10-doctor-appointment.md` | Doctor profiles, availability, materialized slots, appointments, waitlist |
| 11 | Diagnostics & Lab Bookings | `module-11-diagnostics-lab.md` | Diagnostic bookings, home collection, results (versioned, encrypted) |
| 12 | Consultation & Health Records | `module-12-consultation-health-records.md` | Telemedicine sessions, e-prescriptions, records vault, consent, access log |
| 13 | Notifications & Communication | `module-13-notifications.md` | Multi-channel engine (push/SMS/email/in-app), templates, preferences, delivery |
| 14 | Search & Discovery | `module-14-search-discovery.md` | Unified geo/typo-tolerant search read-models (CQRS projections) |
| 15 | Reviews & Ratings | `module-15-reviews-ratings.md` | Verified-transaction reviews, aggregates, moderation |
| 16 | Admin & Platform Management | `module-16-admin-platform.md` | Platform config, feature flags, disputes, oversight, analytics |

**Supporting docs**
- `00-shared-conventions.md` — cross-cutting patterns every module reuses (error envelope, RBAC, audit, outbox, config, money, IDs).
- `00-domain-event-catalog.md` — all domain events emitted/consumed (inter-module contracts).
- `00-implementation-roadmap.md` — build playbook: monolith assembly, phase-by-phase epics + definition of done, migration/seed strategy, testing strategy, env config.
- `00-decision-log.md` — architecture decision records (ADRs) capturing key, hard-to-reverse choices.

---

## 2. Phase Roadmap

**Phase 0 — Foundation (cross-cutting, built first/alongside).**
`01 Identity` → `02 Profiles` → `13 Notifications`. These underpin everything (auth, recipients, comms).

**Phase 1 — Pharmacy Marketplace MVP.**
`03 Catalog` → `04 Pharmacy & Inventory` → `05 Prescription & Matching` → `06 Orders` → `07 Payment` → `08 Delivery`.
Delivers the end-to-end flow: browse medicines → prescription/match → order → pay → deliver.

**Phase 2 — Healthcare Services.**
`09 Provider Directory` → `10 Doctor & Appointment` → `11 Diagnostics` → `12 Consultation & Health Records`.
Adds hospitals/labs/doctors, appointments, lab bookings, telemedicine + records vault.

**Phase 3 — Growth & Optimization (cross-cutting, incrementally).**
`14 Search` (upgrade Postgres→OpenSearch), `15 Reviews`, `16 Admin` (control plane matures throughout).

> Search (14), Reviews (15), and Admin (16) are cross-cutting: minimal versions appear in Phase 1, then mature in Phase 3.

---

## 3. Dependency Map

**Legend:** `A → B` means A depends on B (A consumes B's ports/events).

```
                         ┌─────────────────────────────┐
                         │        01 Identity          │  (RBAC, audit, orgs, verification)
                         └─────────────────────────────┘
                                    ▲  ▲  ▲
        ┌───────────────────────────┘  │  └───────────────────────────┐
        │                              │                              │
  02 Profiles                    13 Notifications              (all modules)
   (beneficiary                   (recipients, prefs)
    access policy)
        ▲
        │
── Phase 1 ─────────────────────────────────────────────────────────────────
  03 Catalog ◄── 04 Pharmacy/Inventory ◄── 05 Prescription/Matching
       ▲                 ▲                        ▲
       │                 │                        │
       └──────── 06 Orders ──────────────┬────────┘
                    │                     │
                    ▼                     ▼
                07 Payment            08 Delivery
── Phase 2 ─────────────────────────────────────────────────────────────────
  09 Provider Directory ◄── 10 Doctor/Appointment ◄── 12 Consultation/Records
       ▲                          ▲                         ▲
       └──── 11 Diagnostics ──────┘                         │
                    │                                       │
                    └──────────── (results → records) ──────┘
── Cross-cutting ────────────────────────────────────────────────────────────
  14 Search  ◄── projects read-models from 03/04/09/10/15 (via events)
  15 Reviews ◄── verified via 06/08/10/11; feeds 14 + provider metrics
  16 Admin   ◄── orchestrates ALL via admin ports; reads 01 audit log
```

### 3.1 Key dependency notes
- **Everything → 01 Identity** for auth/RBAC/audit; providers/orgs verified here.
- **02 Profiles `BeneficiaryAccessPolicy`** is reused by 05, 10, 11, 12 for "acting on behalf of a family member".
- **03 Catalog is the shared product master**; 04 listings reference it (classification immutable by pharmacies).
- **04 availability engine** is the single stock source consumed by both **05 matching** and **14 search**.
- **06 Orders is the saga orchestrator** — sequences 05 (Rx gate/match) → 04 (reserve) → 07 (pay) → 08 (deliver).
- **07 Payment double-entry ledger** is the single money authority; refunds/settlements/earnings route through it.
- **12 Records is an aggregation index** over 05 (prescriptions), 11 (results), and its own consult notes.
- **14 Search owns no data** — CQRS read-side projecting events from 03/04/09/10/15.
- **16 Admin owns almost no data** — thin control plane invoking each module's admin port; read-only over the 01 audit log.

---

## 4. Cross-Cutting Patterns (see `00-shared-conventions.md`)

| Pattern | Where established | Reused by |
| --- | --- | --- |
| **Error envelope** (`success/data/error/meta`) | 01 §14 | all |
| **RBAC** `resource:action[:scope]` + `PermissionsGuard` | 01 §6 | all |
| **Hash-chained audit log** (`audit_logs`, prev_hash/hash) | 01 §14 | all |
| **Ledger + derived balance** (append-only, balances derived) | 07 (money), 04 (stock), 05 (dispensing), 08 (earnings) | — |
| **Reservation/hold + TTL** (atomic, sweeper-released) | 04 (stock), 10 (slots) | 06, 11 |
| **Checkout/booking saga + compensation** | 06 | 10, 11 |
| **Outbox pattern** (reliable event publishing) | 06, 07 | 03, 04, 09, 10, 14 |
| **Eligibility policy** (verified + license-valid + not suspended) | 04 (pharmacy), 09 (provider) | 05, 10, 11, 14 |
| **Snapshots** (immutable copies for history) | 02, 06 | 08, 10, 11 |
| **Config-driven parameters** (`IConfigPort`) | 16 | all tunables |
| **Search read-model behind `ISearchEngine`** (pg→OpenSearch) | 03, 09, 14 | — |
| **Envelope encryption for health artifacts** (KMS) | 05, 11, 12 | — |

---

## 5. Technology Summary

- **Backend:** NestJS (TypeScript), Clean Architecture (domain/application/infrastructure/interface).
- **DB:** PostgreSQL via Prisma; UUID v7 PKs; money as integer minor units (ETB); read replicas.
- **Cache/Queue/Realtime:** Redis (permission cache, availability, sessions/OTP), BullMQ (notification/queue), Redis pub/sub + WebSocket (tracking, telemedicine signaling).
- **Search:** Postgres pg_trgm/GIN + PostGIS at launch; OpenSearch at scale (behind `ISearchEngine`).
- **Media:** managed SFU (LiveKit/Twilio) for telemedicine (behind `IRealtimeMediaPort`).
- **External:** Fayda ID (identity), SMS gateway (ET + international), FCM (push), email provider, payment gateways (Telebirr/bank/card/cross-border), maps/routing.
- **Localization:** Amharic + English throughout; Ethiopian address model + ET geofence.

---

## 6. How to Read a Module Doc

Every module doc follows the same structure: Objectives → Business Requirements → Functional Requirements → NFRs → Domain Model (aggregates/VOs/invariants) → DB Design → API Design → NestJS Folder Structure → Sequence Flows → Error Handling → Logging/Auditing → Future Scalability → Open Questions.

All docs contain **no implementation code** — contracts, schemas, flows, and reasoning only, detailed enough to implement without re-designing.

---

## 7. Consolidated Open Questions

Each module lists open questions for Product/Compliance. Recurring cross-module themes to resolve before build:
1. **Regulatory bodies** — which Ethiopian authorities validate pharmacy/provider/doctor licenses and drug references (EFDA)? (03, 09, 10)
2. **Controlled substances online** — which schedules are permitted vs prohibited? (03, 04, 05)
3. **Payment providers & flows** — launch gateways, auth-vs-capture support, settlement cadence, COD reconciliation. (07, 08)
4. **Retention periods** — prescriptions, results, records, financial data. (05, 11, 12, 07)
5. **Verification model for Rx** — dispensing-pharmacy vs platform pre-verification. (05)
6. **Split fulfillment** — enable multi-pharmacy orders at launch? (04, 05, 06)
7. **Search engine at launch** — Postgres FTS (recommended) vs OpenSearch day one. (03, 09, 14)
8. **Admin roles & maker-checker scope** — role taxonomy and two-person controls. (16)

---

*End of architecture index.*
