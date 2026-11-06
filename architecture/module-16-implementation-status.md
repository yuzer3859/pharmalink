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
| 9.2 | Impersonation (`/admin/accounts/:id/impersonate`, `/admin/impersonation-sessions`) | COMPLETE | Work 85 ([impersonation.md](../backend/docs/impersonation.md)): read-only "view as", always two administrators, never a platform account, 15-minute token with no refresh, revoked on end, the holder notified, every request audited with both identities. Accounts drawer: request, start, read-only view, end |
| 9.3 | Catalogue moderation (`/admin/catalog/review`: queue, submit, approve, reject, resubmit, history, summary) | COMPLETE | |
| 9.3 | Review moderation (hide, remove, restore) | BLOCKED | Module 15 (ratings and reviews) is not implemented |
| 9.3 | Unified flagged-content view | BLOCKED | Same: no flag sources exist yet |
| 9.4 | Versioned configuration with history and rollback (`/admin/config`) | COMPLETE | |
| 9.4 | Feature flags (`/admin/feature-flags`) | COMPLETE | |
| 9.5 | Finance overview, payments, refunds (read) (`/admin/finance`) | COMPLETE | Read-only by design of this surface |
| 9.5 | Settlements (`/admin/finance/settlements`, Module 07) | COMPLETE | Run (Module 07); approve and pay through maker-checker, verified payout destinations with a 24-hour cooling-off on change, PROCESSING for unconfirmed payouts, one `SETTLEMENT` posting (Work 83, [settlement-payout.md](../backend/docs/settlement-payout.md)). No real payout rail exists: a mock rail outside production, fail-closed in production |
| 9.5 | Refund approval with maker-checker for high value | COMPLETE | Work 84: refunds above `approvals.highValueRefundThreshold` (default 10,000 birr) need a second finance officer (`POST /admin/finance/payments/{id}/refunds`); Module 07's own refund route refuses them single-actor (`REFUND_APPROVAL_REQUIRED`). Finance page payment drawer has a refund form |
| 9.6 | Disputes (`/admin/disputes`, customer `/disputes`) | COMPLETE | COD disputes (`/admin/cod-disputes`) and, since Work 86 ([disputes.md](../backend/docs/disputes.md)), general cases about an order, its delivery or payment: customer or admin intake, thread with internal notes, working states, SLA by priority with an overdue flag, assignment, and resolution with no action or a refund through Work 84's rules (a high-value one waits for a second officer, then completes the case). Portal: Disputes page (admin, super admin, finance) |
| 9.7 | Analytics overview (`/admin/analytics/overview`) | PARTIAL | One overview snapshot; no per-area dashboards |
| 9.7 | Audit explorer (`/admin/audit`, read-only, hash chain) | COMPLETE | |
| 9.7 | Admin activity and anomaly monitoring (`/admin/admins/activity`) | DEFERRED | Not designed in detail |
| NFR-SEC-06 | Maker-checker for sensitive actions (`/admin/approvals`) | COMPLETE | Workflow built (Work 82, [backend/docs/maker-checker.md](../backend/docs/maker-checker.md)): pending requests, a different checker holding the action's permission, expiry (`approvals.ttlHours`), reject with a reason, every step audited, execution through the owning module with the key `approval:<id>`, and the configurable list `approvals.makerCheckerActions`. Registered actions, all on by default: settlement approval, payout and payout-destination verification (Work 83), high-value refunds (Work 84). Configuration publishing and role grants stay single-actor and audited (module-16 open question 2) |
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
| Verifications queue | `/admin/verifications` | COMPLETE (Work 75): queue (status, type, waiting time), review drawer, approve (licence number and future expiry required for a pharmacy licence) and reject with a reason. Document preview remains BLOCKED (references only) |
| Configuration and feature flags | `/admin/config`, `/admin/feature-flags` | COMPLETE (Work 76): Super Admin Configuration page: settings with effective value and source, typed publish with range/allowed checks and an audited reason, version history with restore; feature flags with confirmed toggles |
| Catalogue review | `/admin/catalog/review` | COMPLETE (Work 77): queue with summary (waiting count, oldest, lifetime approvals and rejections), name/status/type filters, product drawer with review history, and the decisions the server allows (submit, approve, reject with reason, return to review) |
| Finance, COD disputes | `/admin/finance`, `/admin/finance/settlements`, `/admin/cod-disputes` | COMPLETE (Work 78): Finance page (overview, payments with refund detail, refunds, settlements) and COD disputes page (list, collection detail, resolve with an optional note). Work 83: a settlement drawer with approve, pay, refresh, payout attempts and the pharmacy's payout destination (register; verify through Approvals). Running a settlement stays an API/CLI action |
| Pending approvals (admin, super admin, finance) | `/admin/approvals` | COMPLETE (Work 82): queue by status and "only my requests", which actions currently need a second administrator, and a drawer with what will run, approve (optional note) and reject (reason required) for a permitted checker. The maker is told a different administrator must decide. Empty until Works 83 and 84 register actions |
| Finance portal (Finance Officer) | `/admin/finance`, `/admin/finance/settlements`, `/admin/cod-disputes` | COMPLETE (Work 81): a `FINANCE_OFFICER` signs in to its own portal (`/finance`, no administrator MFA) that opens on Finance and offers Finance and COD disputes only (and Pending approvals since Work 82); settlements and dispute resolution with `finance:settlement:any`. The server refuses every other admin read (e2e) |

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
operator could not tell which pharmacy they were activating.

## Outside Module 16

The pharmacy portal's own pages (inventory, orders, staff, roles for pharmacy staff) still use the
portal's in-memory seed. They belong to Modules 04 and 05 (pharmacy and orders), not to Module 16,
so they are tracked as a follow-up for those modules and not in this document (owner's decision,
2026-11-05). Mock pages are not disguised as live.
