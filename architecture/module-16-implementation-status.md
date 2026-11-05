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
| — | Administrator MFA (Work 66) and first Super Admin bootstrap (Works 65, 68) | COMPLETE | Staging: Resend configured and the first Super Admin bootstrapped, verified and enrolled on 2026-11-03; the portal sign-in fix is #31 |

## Operations portal (`web/`)

Signing in (with administrator MFA) uses the real API. Before Work 69 every data page used an
in-memory seed (`web/src/services/mock/seed.ts`). After Work 74, every admin and super admin page
except Reports uses the real API; the seed now serves only the pharmacy portal and Reports. Works 75–78
added the pages the portal lacked: verifications, configuration, catalogue review, finance and COD
disputes.

| Portal page | Backend it should use | Status |
|---|---|---|
| Sign-in, MFA enrolment and verification | `/auth/*` | COMPLETE |
| Audit Logs (admin, super admin) | `GET /admin/audit` | COMPLETE (Work 69): server-paged, exact-match filters, read-only |
| Pharmacies | `/admin/operations/pharmacies` (read); activation is `POST /pharmacy/activate` | COMPLETE (Work 70): server-paged, status and eligibility filters, activation with the server's refusal reasons. No suspend action: the backend has none. Rows show the pharmacy's public display name (Work 80) |
| Orders | `/admin/operations/orders` | COMPLETE (Work 71): admin portals get a read-only, server-paged orders page (status, COD, exact order number) with a detail drawer (fulfillments, payment status, fees). The pharmacy portal keeps its own page |
| Inventory | `/admin/operations/inventory/*` | COMPLETE (Work 72): admin portals get a read-only, server-paged listings page (pharmacy id, enabled, purchasable) with a stock-diagnostics drawer (reserved, unexpired batches, stored vs computed). The pharmacy portal keeps its own page |
| Dashboard, Analytics | `/admin/analytics/overview` | COMPLETE (Work 73): admin portals show the platform snapshot (account, pharmacy, order, fulfillment, delivery, catalogue breakdowns and the COD cash summary). No trend charts: the API has no time series. The pharmacy portal keeps its own pages |
| Staff (admin portals) | `/admin/accounts` | COMPLETE (Work 74): Accounts page, server-paged, exact phone/e-mail, status and primary-role filters; detail drawer with suspend (required reason) and reinstate, role assignment (organisation id for ORG roles) and revocation |
| Roles | `/admin/roles`, `/admin/accounts/:id/roles` | COMPLETE (Work 74): read-only role catalogue with permissions; roles come from the RBAC seed and have no edit API. Assignment is on the Accounts page |
| Reports | none | BLOCKED: no reporting API exists |
| Pharmacy portal pages (inventory, orders, staff, roles) | Module 04/05 pharmacy APIs, not Module 16 | PARTIAL: mock; outside this module |
| Verifications queue | `/admin/verifications` | COMPLETE (Work 75): queue (status, type, waiting time), review drawer, approve (licence number and future expiry required for a pharmacy licence) and reject with a reason. Document preview remains BLOCKED (references only) |
| Configuration and feature flags | `/admin/config`, `/admin/feature-flags` | COMPLETE (Work 76): Super Admin Configuration page: settings with effective value and source, typed publish with range/allowed checks and an audited reason, version history with restore; feature flags with confirmed toggles |
| Catalogue review | `/admin/catalog/review` | COMPLETE (Work 77): queue with summary (waiting count, oldest, lifetime approvals and rejections), name/status/type filters, product drawer with review history, and the decisions the server allows (submit, approve, reject with reason, return to review) |
| Finance, COD disputes | `/admin/finance`, `/admin/finance/settlements`, `/admin/cod-disputes` | COMPLETE (Work 78): Finance page (overview, payments with refund detail, refunds; settlements read-only for `finance:settlement:any`) and COD disputes page (list, collection detail, resolve with an optional note). Running, approving or paying settlements is not in the portal (DEFERRED) |

## Live verification on staging (Work 80)

The staging stack carries an idempotent verification baseline (`npm run staging:seed`, see
[ops/staging/README.md](../ops/staging/README.md#verification-baseline-and-admin-walkthrough-work-80)).
On 2026-11-05 the owner ran the scripted walk (`npm run staging:walk`) as Admin and as Super
Admin, then clicked through every admin page; both matched. What the walk did:

| Page | Admin | Super Admin |
|---|---|---|
| Every page and drawer the role is offered | loaded (200) | loaded (200) |
| Accounts: suspend, reinstate | done | done |
| Accounts: assign and revoke a role | refused 403 (no `rbac:manage`; the portal offers no role controls) | done |
| Verifications: approve and reject a pharmacy licence; approve FAYDA and DRIVER_DOCS; reject DOCTOR_LICENSE | done | done |
| Pharmacies: activate | done | done |
| Catalogue review: submit, approve, reject, resubmit | done | done |
| COD disputes: resolve | refused 403 (finance only; the portal offers no resolve button) | done |
| Configuration: toggle a flag, publish twice, roll back | refused 403 (Super Admin page) | done |
| Finance settlements | refused 403 (`finance:settlement:any`; not shown to Admin) | loaded |

The first walk found one gap, fixed in the same Work: pharmacy rows carried no name, so an
operator could not tell which pharmacy they were activating. The Finance Officer has no portal yet
(Work 81).

Mock pages are not disguised as live: replacing each one with its real API is the remaining
portal work, one page per Work, each with service-level tests (Vitest, `npm test` in `web/`).
