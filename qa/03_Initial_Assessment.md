# PharmaLink Ethiopia — Initial QA Assessment

**Assessment date:** 2026-07-12 (baseline); updated 2026-08-17 with backend evidence  
**Assessment type:** Static repository review plus build/test verification  
**Release decision:** **No release approval** (Identity module has real verified evidence; all other modules remain unverified)

## 1. Evidence reviewed

- Customer application routes and components in `app/src`.
- Portal service layers and mock seed architecture in `web/src/services`.
- Functional requirements, non-functional requirements, business rules, acceptance criteria, and risk register in `bussiness analysis/markdown`.
- Package scripts for the two Vite applications.
- **New:** `backend/` — a NestJS modular-monolith with a Prisma multi-schema data layer (16 modules planned; only `identity` implemented), unit tests (`npm run test`), and Docker-container-backed e2e tests (`npm run test:e2e`) executed directly against real Postgres via `@testcontainers/postgresql`.

## 1a. Backend execution results (2026-08-17)

| Suite | Command | Result |
| --- | --- | --- |
| Unit/component | `npm run test` (backend) | **43 suites / 194 tests passed** — domain entities, value objects, all identity commands/queries, RBAC guard, crypto, audit-hash, error envelope |
| Integration/e2e | `npm run test:e2e` (backend, real Postgres 16 container, migrations applied) | **7 suites / 40 tests passed** — registration+OTP, login/refresh rotation + theft detection, logout-all, RBAC permVersion invalidation, account suspension/reactivation, Fayda verification workflow, phone normalization, standard error envelope over real HTTP |

This is genuine system-level evidence, not a mock-data assumption: tests boot the real Nest app, hit real HTTP routes with `supertest`, persist to a disposable Postgres database, and assert on both HTTP responses and raw database rows. Confirmed-working behavior includes:

- OTP-gated registration with role assignment, password hashing, and outbox-driven notification dispatch (`QA-AC-001` — now **Passed** for the identity module).
- Refresh-token rotation with reuse/theft detection revoking the entire token family (`QA-AC-004` partial — session integrity confirmed).
- RBAC enforcement where a revoked role or permission invalidates already-issued access tokens via `permVersion`, not just future logins (`QA-AC-004` — Passed for RBAC).
- Account suspension/reactivation invalidating all sessions and blocking login while suspended, without resurrecting pre-suspension sessions on reactivation (`QA-ADM-001` partial).
- Fayda verification submit → admin queue → approve/reject-with-reason → status callback, with the Fayda ID never echoed unmasked in any response (`QA-AC-002` — Passed for backend contract; UI integration still unverified).
- Phone normalization consistency across local/international input formats for register, verify, reset, and login (regression-tagged; prevents a specific real bug class).
- Standard success/error envelope, request-id propagation, mass-assignment rejection (`whitelist`+`forbidNonWhitelisted`), and no stack-trace leakage on unexpected errors.

**Caveats:**
- Only the `identity` module (of 16 planned modules per `backend/README.md`) has implementation and test coverage. Catalog, pharmacy, prescription, orders, payment, delivery, provider, appointment, diagnostics, consultation, notifications, search, reviews, and admin modules are schema-only (Prisma models) with no service/controller/test code found under `src/modules`.
- No frontend (`app`, `web`) is yet wired to this backend; API integration between UI and backend is still unverified.
- E2E tests use `InMemoryOtpService` and `MockFaydaProvider` (dev-mode stand-ins) — real SMS/Fayda-registry integration is unverified.
- Performance, load, penetration, accessibility, and production-configuration (secrets, TLS, real Fayda/SMS provider) testing has not been executed against this backend.

## 2. Current verification status

| Area | Repository evidence | QA status |
| --- | --- | --- |
| Customer navigation | Routes exist for home, medicines, doctors, diagnostics, tracking, checkout, and design system | UI presence only; workflow not verified |
| Medicine search/filter | Local mock data and client-side filtering exist | Partial functional candidate; no persistence, stock authority, or API proof |
| Cart/checkout/payment | Route is referenced, but no checkout page was found in the listed `app/src/pages` files | Blocked; must not claim payment/order works |
| Prescription upload/verification | Upload-oriented copy/buttons exist; no verified storage, pharmacist queue, or review integration found | Blocked |
| Doctor booking | Local modal changes state to “confirmed” | Prototype-only; no slot persistence, payment, reminder, or concurrency proof |
| Diagnostics booking | Book buttons are rendered; no booking state/service found in reviewed source | Blocked |
| Tracking | Animated mock map/timeline and static order data exist | Prototype-only; no real location feed or order linkage |
| Pharmacy/admin portal | Inventory, orders, and staff service modules use in-memory mock stores and simulated latency | Service-unit candidate only; not connected to the new backend yet |
| `web` portal build/shell | Verified 2026-08-17: `main.tsx`/`App.tsx`/router/guards/9 pages now present; build, lint, and dev server all pass; manually smoke-tested in browser | UI shell **Passed**; see `GAP-WEB-002` for auth/API wiring |
| Frontend/backend API integration | `web`/`app` still call local mock services (`auth.service.ts` uses `DEMO_USERS` + simulated latency); `backend` exposes real Identity HTTP routes but nothing in the frontend calls it | Blocked; no wiring evidence between UI and backend exists (`GAP-WEB-002`) |
| **Backend — Identity module** | Real NestJS module (controllers/commands/queries/guards) with 194 unit tests and 40 e2e tests passing against a real Postgres container | **Verified** for register/OTP, login/refresh/logout, RBAC/permVersion, suspension/reactivation, Fayda submit/approve/reject, phone normalization, error envelope |
| **Backend — all other 15 modules** (catalog, pharmacy, prescription, orders, payment, delivery, provider, appointment, diagnostics, consultation, notifications, search, reviews, admin) | Prisma schema files exist (`prisma/schema/03-*` through `16-*`); no controllers/services/tests found under `src/modules` | Not implemented; not testable |
| Security/privacy | Requirements specify controls, but repository evidence is insufficient to prove them | Blocked pending deployed environment and security evidence |
| Performance | Requirements define targets, but no load results exist | Not tested |
| Accessibility/localization | Requirements define WCAG and Amharic support, but no audit evidence exists | Not tested |

## 3. High-risk observations requiring defects or backlog items

1. **Resolved:** `npm run build` for `app` was executed and completed successfully (exit code 0, 1916 modules transformed), so the `Checkout`/`DesignSystem` route imports are not a compile failure. This item is closed; no defect required.
2. **Prototype behavior is not system behavior:** customer pages use local mock data and local React state. Add/search/filter/booking/tracking interactions do not demonstrate server persistence, identity, payment, notification, or authorization.
3. **Payment and Rx safety are unverified:** there is no evidence of payment provider callbacks, idempotency, tokenization boundary, prescription encryption, pharmacist authorization, or controlled-substance enforcement.
4. **Order transition integrity is unverified:** the portal order service accepts any `OrderStatus` without validating the declared lifecycle. API/server enforcement is required before release.
5. **Inventory status risk:** `inventoryService.list` filters on the stored `status` field, while `update` derives status. A data-refresh or seed path that leaves status stale could expose incorrect availability; test derived status against quantity, reorder level, and expiry.
6. **Tenant isolation needs proof:** scope filtering is implemented in client-side service code. Authorization must be enforced in the backend, not only by the UI/service caller.
7. **Mock storage is process-local:** inventory/orders/staff stores reset on reload/restart and are not suitable evidence for persistence, audit, reconciliation, or multi-user concurrency.
8. **Requirements are draft:** business, functional, acceptance, and risk documents are marked Draft for Review. QA exit criteria cannot be signed until requirements and compliance policy are baselined.

## 4. Immediate execution order

1. ~~Run clean production builds for both applications and capture logs.~~ **Done** — `app` build passes; `web` build fails with a confirmed defect (see `DEFECT-WEB-001`, Section 6).
2. **Blocked:** `app` has no missing imports; `web` is missing its entry point/root component entirely (`main.tsx`, `App.tsx`, `pages/`) — this must be implemented before any `web` functional execution can start.
3. Add automated tests for pure service logic: inventory status, scope filtering, order transition validation, totals, and idempotency (still applies to the `web` mock services; not yet superseded by `backend`).
4. **Partially done:** `backend/` now provides a real deployable Identity API with Postgres persistence, RBAC, audit hashing, and Docker-based e2e harness. Extend this pattern to the remaining 15 modules (catalog, pharmacy, prescription, orders, payment, delivery, provider, appointment, diagnostics, consultation, notifications, search, reviews, admin) before any of those workflows can be tested end-to-end. Sandbox payment, real Fayda registry, SMS/email/push, maps, and object storage integrations are still outstanding.
5. Execute all P0 cases in `02_Test_Cases.md` that map to Identity now that backend evidence exists (`QA-AC-001..004`, portions of `QA-ADM-001`); all remaining P0 cases stay blocked until their modules are implemented.
6. Track every failure as a defect with evidence; do not mark a case Passed from source inspection. Wire the frontend (`app`/`web`) to the real backend before claiming any UI-driven workflow is verified.

## 5. Required release sign-offs

- Product owner: acceptance criteria and user journeys.
- Engineering: build, API, persistence, observability, rollback, and defect closure.
- Security: threat model, SAST/DAST, penetration retest, secrets and access review.
- Compliance/legal: Rx, provider licensing, controlled substances, privacy, retention, audit, and regulator access.
- Operations/finance: delivery, refunds, settlement, reconciliation, and support readiness.
- UAT representatives: customer, pharmacist, provider, rider, admin, diaspora, and regulator personas.

## 6. Follow-up items opened this session

- **DEFECT-WEB-001 — RESOLVED (verified 2026-08-17):** `web/src` now has `main.tsx`, `App.tsx`, `routes/AppRouter.tsx`, `routes/guards.tsx`, `routes/pageRegistry.tsx`, `config/navigation.tsx`, `components/{layout,common,charts}`, and 11 `features/*` modules. Re-verified: `npm run build` (`tsc -b && vite build`) exits 0 and produces `dist/`; `npm run lint` reports 0 errors (3 pre-existing fast-refresh warnings in context files, non-blocking); `npm run dev` serves on `http://localhost:5173` and the portal-select → dashboard flow renders and navigates correctly in a live browser preview. Three portals (`pharmacy`, `admin`, `superadmin`) route to 9 registered pages (`dashboard`, `inventory`, `orders`, `analytics`, `reports`, `staff`, `roles`, `pharmacies`, `audit`) gated by `RequirePortal`/`RequirePermission`.
- **New observation:** `web/src/services/auth.service.ts` and `apiClient.ts` are still mock/demo (`DEMO_USERS`, `simulate()` with artificial latency, no real HTTP call, no password field, `login(portal)` just switches identity by portal key). The UI shell is verified functional; it is **not yet wired to the real `backend` Identity API** confirmed working in Section 1a. Session persists only via `localStorage`, not real JWTs. This is a distinct integration gap, not a build defect — track separately as `GAP-WEB-002` (frontend↔backend wiring for auth, inventory, orders, staff, roles, pharmacies, audit, reports, analytics).
- No test runner (`vitest`/`jest`) is configured in `web/package.json` — component/unit test coverage for the new `features/*` and `hooks/*` code is currently zero. Recommend adding Vitest + React Testing Library before this module set grows further.
- Track backend module rollout (schema exists for all 16 modules; controller/service/test code exists for `identity` only) against the roadmap in `bussiness analysis/markdown/12_Product_Roadmap.md`.
- Add e2e coverage for the remaining 15 backend modules using the same `test-app.ts`/`test-database.ts`/testcontainers pattern already established in `backend/test`.
