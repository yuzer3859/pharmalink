# Phase 1: Pharmacy Marketplace MVP — status (audit, Work 93, 2026-11-07)

This audit compares the roadmap's Phase 1 (`00-implementation-roadmap.md` §3) with the code on
`main` at 8ad123c. It covers Modules 03 to 08, the minimal Module 14 search, the minimal Module 16
admin, and the customer app (`app/`). It is the definition of done for the Phase 1 close-out
(Works 93 onwards). Each Work updates this file with its evidence.

**Out of scope (owner's decision, 2026-11-05):** Modules 09 to 12 (provider directory, doctors,
diagnostics, consultation). The app shows their pages as "coming later", with no sample data.

## Exit criteria

| Criterion (roadmap §3, Phase 1) | Today | Missing |
|---|---|---|
| Browse → cart → (Rx verify) → checkout → pay → assign driver → deliver → PoD → settle | Each step exists on the backend and is tested on its own. Checkout is cash on delivery only. | Online payment in checkout (G1), capture (G2), settlement of the paid order (G3). No test runs the whole chain (G9). |
| Saga compensation: a payment failure releases the stock reservation | Not possible: no order ever waits for a payment. Cancellation releases reservations (tested). | G1 |
| Ledger balances reconcile in a test | The ledger repository and the reconciliation report are tested. COD orders never reach the ledger (G4). | A test across a full paid order (G9) |
| Minimal Module 14 search (Postgres FTS over catalogue and pharmacies) | The schema has `search_documents` and other read-model tables, but no code fills or reads them. The catalogue's own list uses trigram indexes. | G5 |
| Minimal Module 16 (pharmacy verification, product proposals) | COMPLETE: `module-16-implementation-status.md` | — |
| Customer app on the real API for the whole happy path | Sign-up, e-mail OTP, login, password reset, catalogue list, product detail and availability are live. Cart, checkout, payment, Rx upload, orders, tracking and PoD are prototypes. | G6, G7 |

## Epics against the code

| Epic | Backend | Notes |
|---|---|---|
| 03 Catalog: products, Rx/OTC/controlled, categories, equivalence, proposals, events | Present | Public `GET /catalog/products`, `/catalog/categories`; admin review (Module 16) |
| 04 Pharmacy/Inventory: onboarding, verification, listings, batches, stock ledger, reservations with TTL, availability | Present | `reservation-ttl.sweeper.ts` expires holds; `GET /availability/product/:id` is public |
| 05 Prescription/Matching: upload, pharmacist verification, dispensing ledger, matching | Present, with one gap | **G7:** `POST /prescriptions` takes a client-supplied `fileRef` string. No file is stored or checked, and the pharmacist cannot open it. |
| 06 Orders: cart, checkout saga, lifecycle, fulfilments, invoices, outbox | Present, COD only | **G1:** `checkout.command.ts` is "COD-only Slice 1". Saga step 7 (payment authorisation) does not exist, and every order goes straight to `PAID`. **G8:** `orders.paymentId` is never written. |
| 07 Payment: double-entry ledger, gateway adapters, refunds, coupons, settlements, webhooks, fraud flags | Present, with gaps | **G2:** `POST /payments/:id/capture` exists, but nothing calls it at fulfilment (§11.3). **G3:** payments never reach `SETTLED`. **G4:** COD collection and remittance post nothing to the ledger. **G10:** the mock provider is bound unconditionally. |
| 08 Delivery: drivers, jobs, dispatch/offers, WebSocket tracking, PoD, COD, earnings | Present | An order that is ready creates the job, the job dispatches, and completion feeds Orders (event handlers in `delivery/interface/events`) |

## Gaps

| # | Gap | Evidence | Fix |
|---|---|---|---|
| G1 | No prepaid checkout, so no saga compensation | `checkout.command.ts` header ("every order `isCod = true`"). No module outside 07 consumes a `payment.*` event. | Work 95 |
| G2 | No capture at fulfilment, so a prepaid order would never post `CAPTURE` to the ledger | module-07 §11.3 ("Orders OrderReady → capture"); no caller of `CapturePaymentCommand` outside its controller | Work 96 |
| G3 | Payments never reach `SETTLED` after the payout | module-07 §6/§15; Work 83 marks only the statement `PAID` | Work 96 |
| G4 | COD money never reaches the ledger, so COD sales are missing from settlements and reconciliation | `record-cod-collection.command.ts` ("does not move money"), `record-cod-remittance.command.ts` | Work 97 |
| G5 | No search | `prisma/schema/14-search.prisma` has tables but no module | Works 98, 99 |
| G6 | The customer app's cart, checkout, payment, orders, tracking and PoD are prototypes | Mock inventory below | Works 100–102 |
| G7 | Rx upload stores no file | `UploadPrescriptionDto.fileRef` is any string up to 500 characters | Work 101 (backend part first) |
| G8 | `orders.paymentId` is never written | `orderPaidEvent({ paymentId: null })` in `checkout.command.ts` | Work 95 |
| G9 | No end-to-end test of the whole chain, compensation, or reconciliation over a real order | `backend/test/` has per-module specs only | Work 103 |
| G10 | **Production safety:** with no other gateway configured, `MockPaymentProvider` authorises every gateway payment, production included. It also cannot decline, so compensation cannot be shown on staging. | `payment.module.ts` binds `PAYMENT_PROVIDER_PORT` to `MockPaymentProvider` unconditionally | **Done, Work 94:** the mock is unavailable in production, so gateway payments fail closed; the `test-decline` token declines outside production (`backend/docs/test-payment-gateway.md`) |
| G13 | Proof-of-delivery photos and signatures are kept in process memory, lost on restart. This is safe only while `delivery.podRequirement` stays `NONE`. Work 89's document storage is now a real place for them. | `in-memory-proof-artifact.storage.ts`; found during Work 94 | Work 102 (backend part first) |
| G11 | The customer app has no CI job | `.github/workflows` has `backend-ci.yml` and `web-ci.yml` only; `app/` has 4 Vitest files | Work 99 |
| G12 | Amharic copy written by Claude needs native review (`ACCOUNT_IMPERSONATED`, `DISPUTE_UPDATED`, `REVIEW_MODERATED`) | `module-16-implementation-status.md` | Owner (not code) |

## Customer app mock inventory (`app/src`)

| File | Mock | Plan |
|---|---|---|
| `data/mock.js` | `doctors`, `diagnostics`, `cart`, `trackingSteps` | Deleted once nothing imports it (Works 99–102) |
| `pages/Home.jsx` | Imports `doctors` for the doctors strip; "Upload Rx — coming soon" banner | The doctors strip becomes "coming later" (Work 99); the Rx banner goes live (Work 101) |
| `pages/Doctors.jsx` | `doctors`, plus inline `specialties`, `days` and `slots` | "Coming later" page, no data (Work 99) |
| `pages/Diagnostics.jsx` | `diagnostics`, inline `packages`, `types` | "Coming later" page, no data (Work 99) |
| `pages/Checkout.jsx` | `cart` from the mock, inline payment `methods`, a hard-coded address, `setTimeout` instead of an order | Real cart, quote, address, checkout and payment (Work 100) |
| `pages/Tracking.jsx` | `trackingSteps`; hard-coded order number, pharmacy, driver, address and totals | Real order status, tracking WebSocket, PoD (Work 102) |
| `pages/MedicineDetail.jsx` | None. No "add to cart" yet. | Add to cart (Work 100) |
| `pages/DesignSystem.jsx` | Static design samples (not product data) | Kept; not linked from the navigation |

Already on the real API, with Vitest and RTL tests: `auth/*`, `catalog/*`, and the `Medicines`,
`MedicineDetail` and auth pages.

## Decisions taken (recommended option; the owner may overrule)

- **Pharmacy and driver steps in the live walk** are driven by a scripted CLI acting as the pharmacy
  and the driver through the real API (Work 103), the way `staging:walk` acts as the admin. The
  pharmacy portal's pages (`web/`, still in-memory) and a driver app are follow-ups outside this
  mission's definition of done. They are listed in the close-out.
- **Fake gateway:** the mock provider stays the gateway for development, tests and staging. In
  production it refuses to serve unless a real gateway claims the method (fail closed, Work 94). In
  non-production a test token declines deterministically, so staging can show compensation.
- **COD stays available** alongside prepaid. Its ledger posting (G4) follows the chart of accounts'
  `COD_CLEARING` account (module-07 §7).
- **Search** is Postgres full-text search in `search_documents`, filled from outbox events. It never
  reads other modules' tables (Work 98).

## Work plan

| Work | Scope |
|---|---|
| 93 | This audit |
| 94 | Mock provider fails closed in production; deterministic test decline outside production (G10) |
| 95 | Prepaid checkout: the order waits in `PENDING_PAYMENT` with held stock. `payment.authorized` → `PAID`, confirm reservations, write `orders.paymentId`. A failure or expired hold → cancel and release. (G1, G8) |
| 96 | Capture at fulfilment and payments `SETTLED` after the payout (G2, G3) |
| 97 | COD postings to the ledger (G4) |
| 98 | Module 14 minimal search backend: projection, FTS, public API (G5) |
| 99 | App: CI job, search UI, Doctors and Diagnostics as "coming later" (G5, G11) |
| 100 | App: cart, checkout, fake-gateway payment (G6) |
| 101 | Rx upload through document storage, pharmacist preview, app Rx upload (G7) |
| 102 | PoD artifacts in document storage; app: orders, status, live tracking, PoD (G6, G13) |
| 103 | Phase 1 e2e suite (whole chain, compensation, reconciliation); scripted pharmacy and driver actors; live walk (G9) |
| 104 | Close-out: this file and the roadmap |
