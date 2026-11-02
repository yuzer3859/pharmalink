# Module 16 — implementation status (audit, 2026-11-02)

An audit of [module-16-admin-platform.md](module-16-admin-platform.md) against `main` at `0f6e9cc`
(after Works 66–68), updated as each later Work lands. It separates the **backend API** (what an
administrator can do through `/admin/*`) from the **operations portal** (`web/`, what an
administrator can do in a browser), because the two are at very different stages.

Status key:

- **COMPLETE**: implemented and tested end to end.
- **PARTIAL**: some of the design is implemented; the rest is listed.
- **BLOCKED**: needs something outside this module first (named).
- **DEFERRED**: deliberately not built yet (reason given).

## Backend API (`backend/src/modules/admin`, plus owning modules)

| Design § | Capability | Status | Notes |
|---|---|---|---|
| 9.1 | Verification queue, detail, approve, reject (`/admin/verifications`) | COMPLETE | Pharmacy licence approval with licence number and expiry, organisation lifecycle (Work 67) |
| 9.1 | Document preview in the review | BLOCKED | Needs a document-storage read path (signed URLs); documents are references only |
| 9.2 | Account search, detail, suspend, reinstate (`/admin/accounts`) | COMPLETE | |
| 9.2 | Role assignment and revocation (`/admin/accounts/:id/roles`, `/admin/roles`) | COMPLETE | |
| 9.2 | Impersonation | DEFERRED | Requires maker-checker (below); intentionally absent |
| 9.3 | Catalogue moderation (`/admin/catalog/review`: queue, submit, approve, reject, resubmit, history, summary) | COMPLETE | |
| 9.3 | Review moderation (hide, remove, restore) | BLOCKED | Module 15 (ratings and reviews) is not implemented |
| 9.3 | Unified flagged-content view | BLOCKED | Same: no flag sources exist yet |
| 9.4 | Versioned configuration with history and rollback (`/admin/config`) | COMPLETE | |
| 9.4 | Feature flags (`/admin/feature-flags`) | COMPLETE | |
| 9.5 | Finance overview, payments, refunds (read) (`/admin/finance`) | COMPLETE | Read-only by design of this surface |
| 9.5 | Settlements (`/admin/finance/settlements`, Module 07) | COMPLETE | Owned by the payment module |
| 9.5 | Refund approval with maker-checker for high value | DEFERRED | Maker-checker not built |
| 9.6 | Disputes | PARTIAL | COD disputes only (`/admin/cod-disputes`: list, detail, resolve). General dispute CRUD and threads are not built |
| 9.7 | Analytics overview (`/admin/analytics/overview`) | PARTIAL | One overview snapshot; no per-area dashboards |
| 9.7 | Audit explorer (`/admin/audit`, read-only, hash chain) | COMPLETE | |
| 9.7 | Admin activity and anomaly monitoring (`/admin/admins/activity`) | DEFERRED | Not designed in detail |
| NFR-SEC-06 | Maker-checker for sensitive actions | DEFERRED | No dual-control workflow exists; actions are single-actor and audited |
| — | Operations visibility (`/admin/operations/*`: pharmacies, branches, orders, fulfilments, deliveries, drivers, COD, inventory listings, batches, movements, reservations, integrity) | COMPLETE | Beyond the original design; read-only |
| — | Notification delivery operations (`/admin/notifications/*`) | COMPLETE | |
| — | Administrator MFA (Work 66) and first Super Admin bootstrap (Works 65, 68) | COMPLETE | Staging bootstrap waits for the owner's Resend credentials |

## Operations portal (`web/`)

Signing in (with administrator MFA) uses the real API. Before Work 69 every data page used an
in-memory seed (`web/src/services/mock/seed.ts`).

| Portal page | Backend it should use | Status |
|---|---|---|
| Sign-in, MFA enrolment and verification | `/auth/*` | COMPLETE |
| Audit Logs (admin, super admin) | `GET /admin/audit` | COMPLETE (Work 69): server-paged, exact-match filters, read-only |
| Pharmacies | `/admin/operations/pharmacies` (read); activation is `POST /pharmacy/activate` | PARTIAL: mock |
| Orders | `/admin/operations/orders` | PARTIAL: mock |
| Inventory | `/admin/operations/inventory/*` | PARTIAL: mock |
| Dashboard, Analytics | `/admin/analytics/overview` | PARTIAL: mock |
| Staff (admin portals) | `/admin/accounts` | PARTIAL: mock |
| Roles | `/admin/roles`, `/admin/accounts/:id/roles` | PARTIAL: mock |
| Reports | none | BLOCKED: no reporting API exists |
| Pharmacy portal pages (inventory, orders, staff, roles) | Module 04/05 pharmacy APIs, not Module 16 | PARTIAL: mock; outside this module |
| Verifications queue | `/admin/verifications` | Not in the portal yet |
| Configuration and feature flags | `/admin/config`, `/admin/feature-flags` | Not in the portal yet |
| Catalogue review | `/admin/catalog/review` | Not in the portal yet |
| Finance, COD disputes | `/admin/finance`, `/admin/cod-disputes` | Not in the portal yet |

Mock pages are not disguised as live: replacing each one with its real API is the remaining
portal work, one page per Work, each with service-level tests (Vitest, `npm test` in `web/`).
