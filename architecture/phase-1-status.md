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
| Browse → cart → (Rx verify) → checkout → pay → assign driver → deliver → PoD → settle | **Done (Work 103):** automated over the real stack in `test/phase1/marketplace.e2e-spec.ts`. The live staging walk is `ops/staging/phase1-walkthrough.md`. | Owner's live walk |
| Saga compensation: a payment failure releases the stock reservation | **Done (Work 95):** a decline cancels the order and releases its stock and coupon (`test/orders/prepaid-checkout.e2e-spec.ts`) | Staging walk (Work 103) |
| Ledger balances reconcile in a test | **Done (Work 103):** debits equal credits, the pharmacy payable is paid out to zero, and finance reconciliation reports `CLEAN` after a full paid order. COD sales post at handover (Work 97). | — |
| Minimal Module 14 search (Postgres FTS over catalogue and pharmacies) | **Backend done (Work 98):** public `/search/medicines`, `/search/medicines/{id}/pharmacies`, `/search/pharmacies` | App UI (Work 99), staging walk (Work 103) |
| Minimal Module 16 (pharmacy verification, product proposals) | COMPLETE: `module-16-implementation-status.md` | — |
| Customer app on the real API for the whole happy path | **Done (Works 99–102):** search, cart, Rx upload, checkout, gateway payment, orders, live tracking and PoD; no sample data remains in `app/src` | Owner's live walk |

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
| G1 | No prepaid checkout, so no saga compensation | `checkout.command.ts` header ("every order `isCod = true`"). No module outside 07 consumes a `payment.*` event. | **Done, Work 95:** prepaid checkout with compensation, redirect outcomes by event, and an unpaid-order timeout (`backend/docs/prepaid-checkout.md`) |
| G2 | No capture at fulfilment, so a prepaid order would never post `CAPTURE` to the ledger | module-07 §11.3 ("Orders OrderReady → capture"); no caller of `CapturePaymentCommand` outside its controller | **Done, Work 96:** captured when the order is ready, retried by a reconciler (`backend/docs/capture-and-settlement.md`) |
| G3 | Payments never reach `SETTLED` after the payout | module-07 §6/§15; Work 83 marks only the statement `PAID` | **Done, Work 96:** a paid statement settles its payments; a settled payment can still be refunded and is clawed back |
| G4 | COD money never reaches the ledger, so COD sales are missing from settlements and reconciliation | `record-cod-collection.command.ts` ("does not move money"), `record-cod-remittance.command.ts` | **Done, Work 97:** the COD sale is posted when the cash reaches PharmaLink, for the amount handed over; statements are generated automatically by amount or period (owner's decision 2026-11-07, `backend/docs/cod-ledger-and-settlement-triggers.md`) |
| G5 | No search | `prisma/schema/14-search.prisma` has tables but no module | **Backend done, Work 98:** Postgres full-text search with nearby availability, kept in sync by events (`backend/docs/search.md`). **App UI done, Work 99:** the Search page, with Amharic or English text, an Rx/OTC filter, and "Near me" availability. |
| G6 | The customer app's cart, checkout, payment, orders, tracking and PoD are prototypes | Mock inventory below | **Done, Works 100–102:** every customer flow uses the real API |
| G7 | Rx upload stores no file | `UploadPrescriptionDto.fileRef` is any string up to 500 characters | **Done, Work 101:** files go to document storage through signed links and are checked before recording; the owner and the reviewing pharmacist get audited, access-logged read links; the app has a Prescriptions page (`backend/docs/prescription-files.md`) |
| G8 | `orders.paymentId` is never written | `orderPaidEvent({ paymentId: null })` in `checkout.command.ts` | **Done, Work 95:** set when a prepaid order is paid. COD orders have no payment row, so theirs stays null. |
| G9 | No end-to-end test of the whole chain, compensation, or reconciliation over a real order | `backend/test/` has per-module specs only | **Done, Work 103:** `backend/test/phase1/marketplace.e2e-spec.ts` (the whole chain to `SETTLED`, compensation, reconciliation `CLEAN`); live walk in `ops/staging/phase1-walkthrough.md` |
| G14 | An order never followed its delivery: it stayed `READY` after pickup and delivery ("deferred to Module 08", never wired) | `order-status-policy.ts` (`READY` had no outgoing transition); no Orders consumer of `delivery.order.*` | **Done, Work 103:** `delivery.order.picked_up` → `DISPATCHED`, `delivery.order.delivered` → `DELIVERED` (`OrderDeliveryProgressService`); found by the Phase 1 e2e |
| G10 | **Production safety:** with no other gateway configured, `MockPaymentProvider` authorises every gateway payment, production included. It also cannot decline, so compensation cannot be shown on staging. | `payment.module.ts` binds `PAYMENT_PROVIDER_PORT` to `MockPaymentProvider` unconditionally | **Done, Work 94:** the mock is unavailable in production, so gateway payments fail closed; the `test-decline` token declines outside production (`backend/docs/test-payment-gateway.md`) |
| G13 | Proof-of-delivery photos and signatures are kept in process memory, lost on restart. This is safe only while `delivery.podRequirement` stays `NONE`. Work 89's document storage is now a real place for them. | `in-memory-proof-artifact.storage.ts`; found during Work 94 | **Done, Work 102:** artifacts are kept in document storage when it is configured, and opened through an explicit, audited 5-minute link |
| G11 | The customer app has no CI job | `.github/workflows` has `backend-ci.yml` and `web-ci.yml` only; `app/` has 4 Vitest files | **Done, Work 99:** `app-ci.yml` runs the app's Vitest suite and production build on every PR |
| G12 | Amharic copy written by Claude needs native review (`ACCOUNT_IMPERSONATED`, `DISPUTE_UPDATED`, `REVIEW_MODERATED`) | `module-16-implementation-status.md` | Owner (not code) |

## Customer app mock inventory (`app/src`)

| File | Mock | Plan |
|---|---|---|
| `data/mock.js` | **Deleted, Work 102.** No sample data remains in `app/src`. | — |
| `pages/Home.jsx` | None. **Done:** a "coming later" doctors note (Work 99); the Rx banner opens the Prescriptions page (Work 101). | — |
| `pages/Doctors.jsx` | None. **Done, Work 99:** a "coming later" page with no data. | — |
| `pages/Diagnostics.jsx` | None. **Done, Work 99:** a "coming later" page with no data. | — |
| `pages/Checkout.jsx` | None. **Done, Work 100:** the real cart, addresses, the server quote, cash on delivery or a gateway payment, and a decline that offers to rebuild the cart. | — |
| `pages/Tracking.jsx` | **Deleted, Work 102.** Replaced by `Orders.jsx` and `OrderDetail.jsx`: real orders, status history, live tracking over the WebSocket, and proof of delivery. `/tracking` opens the orders. | — |
| `pages/MedicineDetail.jsx` | None. **Done, Work 100:** Add to cart (log in first when signed out). | — |
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

## Close-out (Work 104, 2026-11-08)

Works 93–103 closed every Phase 1 code gap, G1 to G11 plus G13 and G14. Each was merged with all
CI checks green: five checks from Work 99 on, which added the customer app's CI.

| Work | What | PR | Merge |
|---|---|---|---|
| 93 | Audit, gaps and plan | #46 | 20afb09 |
| 94 | Test gateway fails closed in production; `test-decline` (G10) | #47 | 377ed3d |
| 95 | Prepaid checkout saga with compensation; `orders.paymentId` (G1, G8) | #48 | a102c34 |
| 96 | Capture at fulfilment; payments `SETTLED`; refunds after payout (G2, G3) | #49 | ae10219 |
| 97 | COD sale posted when the cash reaches PharmaLink; statements by amount or period (G4, owner's decision) | #50 | b86b6fe |
| 98 | Module 14 minimal search (G5, backend) | #51 | 0ea1e53 |
| 99 | App search; doctors and diagnostics marked "coming later"; app CI (G5, G11) | #52 | 14daaa8 |
| 100 | App cart, checkout, gateway payment (G6) | #53 | 2775591 |
| 101 | Prescription files in document storage; pharmacist preview; app upload (G7) | #54 | 85e0a6d |
| 102 | Proof of delivery in document storage; app orders, live tracking, PoD (G13, G6) | #55 | 23987f2 |
| 103 | Whole-chain e2e; orders follow their delivery; staging walk actors (G9, G14) | #56 | 8f3449f |

**Automated evidence.** `backend/test/phase1/marketplace.e2e-spec.ts` runs the roadmap's three
exit criteria over the real stack:
1. **The whole chain:** search → cart → Rx gate → prescription approved → prepaid checkout → pharmacy
   → capture → delivery job → driver → proof of delivery → delivered → statement → maker-checker
   payout → `SETTLED`.
2. **Compensation:** a declined payment releases the stock reservation.
3. **Reconciliation:** debits equal credits, the pharmacy payable is paid out to zero, and finance
   reconciliation reports `CLEAN`.

It passes in CI with the rest of the suites.

**Staging (2026-11-08).** The stack was redeployed at 8f3449f:
- all 44 migrations applied;
- 14 roles and 74 permissions;
- the baseline seed plus the walk stock: an OTC product and the Rx Amoxicillin at Seed Bole
  Pharmacy, Bole Main;
- the search index built at start-up (5 products, 3 pharmacies, no failures);
- no backend errors.

Checks that need no sign-in passed. `GET /search/medicines?q=ors` finds the walk product with one
pharmacy from ETB 12.00, and `q=amoxicillin` with a location finds it about 1 km away.

### Live walk

**Walked on 2026-11-08 by the owner**, on staging at `main` 952396f plus the Work 105 fixes,
following `ops/staging/phase1-walkthrough.md`. The customer was `yuzer3859+customer@gmail.com`.

| Step | Result |
|---|---|
| Search, cart, Rx gate, prescription upload, pharmacist approval | As written |
| `ORD-4489786b-ffb1-4d0c-9bd3-60dd41998ac1`: ORS and Amoxicillin (Rx), ETB 57.00, **cash on delivery** (the app's default method was left selected) | Pharmacy → ready → driver → proof of delivery → `DELIVERED`, job `COMPLETED`. Not settled: COD is payable only after remittance. |
| `ORD-59edc41f-2bce-45ad-a8ba-141381faa608`: ORS, ETB 12.00, **Telebirr** (test gateway) | `AUTHORIZED` → `CAPTURED` at ready → delivered → statement (1 line, ETB 12.00) → approved → destination registered and verified → payout `PAID` → payment `SETTLED` |
| Declined payment (`test-decline`) | As written: order cancelled, nothing charged, items back in the cart, stock unchanged |
| Ledger | Debits equal credits (ETB 1,409.00 each). The walk's ETB 12.00 payable was paid out to zero. Bole's remaining ETB 745.00 is the seed's own draft statement for the admin walk. |
| Finance reconciliation report (`staging:actors -- reconciliation all`, the same service as `GET /admin/finance/reconciliation`) | `CLEAN`, 0 discrepancies: 3 captured payments, 2 statements, 6 lines, 1 currency examined |

**Deviations found, all fixed in Work 105 (#58) unless noted:**
1. The owner's Resend address is the staging Super Admin, so it cannot be the customer, and
   Resend's test sender refuses every other address. Added `staging:actors -- verify-customer`.
2. The customer app reported *unexpected response* for a staff sign-in (an MFA challenge) and *e-mail
   delivery is not set up* when Resend refused an address. Both messages mislead. **Open.**
3. The checkout's new-address form never sent the map location the backend requires, so no new
   address could be saved. The form now asks for the browser's location.
4. The `driver` tool never put the walk driver online, so dispatch found nobody. It now does.
5. Left online, the driver received the next job's offer from the backend itself, which expired
   before the tool accepted it. Dispatch never re-offers to that driver, so the job stuck. The
   tool now accepts at once, goes offline after, and the seed adds a spare walk driver.
6. The operations portal has no "run statement" action, and the automatic run never triggers for
   a walk-sized amount. Added `staging:actors -- statement now`. A portal action is **open**.
7. The walkthrough left out setting the finance checker's password and registering and verifying
   the pharmacy's payout destination. Added.
8. The operations portal has no reconciliation page, although the report exists in the backend.
   Added `staging:actors -- reconciliation all` (read-only). A portal page is **open**.

### Not built, or still open

| Item | Status |
|---|---|
| Amharic copy written by Claude (`ACCOUNT_IMPERSONATED`, `DISPUTE_UPDATED`, `REVIEW_MODERATED` notifications) (G12) | Needs a native speaker's review |
| Pharmacy portal order, inventory and prescription pages (`web/`, still in-memory) | Follow-up for Modules 04 and 05. The walk uses `staging:actors` instead. |
| Driver app | Not in Phase 1's code. The walk uses `staging:actors`. |
| Customer app error messages for a staff sign-in and a refused e-mail address (live walk, deviation 2) | Open |
| Portal action to run a settlement statement (live walk, deviation 6) | Open. The walk uses `staging:actors -- statement now`. |
| Portal page for the finance reconciliation report (live walk, deviation 8) | Open. The walk uses `staging:actors -- reconciliation all`. |
| Real payment gateway (Telebirr) | Fail-closed until its contract exists (Work 94). Staging uses the test gateway only. |
| Payout destination rules (module-07 §15) | Still open in the design. The mock payout rail pays a verified beneficiary. |
| COD corrections after a remittance | Not reflected in the COD sale posting. A finance adjustment. |
| Prescription references from before Work 101 | Still accepted, but cannot be opened |
| Search: unified cross-entity search, suggestions, typo tolerance, OpenSearch | Not built (Phase 3 in the roadmap) |
| Modules 09–12 | Deferred by the owner |

## Operational completeness (from Work 106, 2026-11-08)

The 2026-11-08 walk proved the chain with `staging:actors` playing the pharmacy, the driver and
parts of finance. The goal of this mission: a real person in each role does their job in their own
app on staging, and no step of the walk uses `staging:actors`. The scripts may stay for automated
setup.

### Housekeeping (Work 106)

- **PR #2** (Module 05: bind checkout match requests to their order): **closed as superseded.**
  `main` already has all of it, from fd1d531:
  - the same migration, byte for byte;
  - identical matching commands, port and errors;
  - an e2e test that is a superset of the PR's.

  The branch also conflicted with `main`.
- **PR #32** (Work 79: no nested buttons on the portal picker; add feature flags from the portal):
  **still needed.** `main` still nests a `<Button>` inside the portal card's `CardActionArea`, and has
  no way to create a flag. Its commit is carried into Work 106 on a fresh branch, and #32 is
  closed in favour of it. The backend's `PUT /admin/feature-flags/:key` already creates a flag.

### Audit: the pharmacy portal (`web/`, portal `pharmacy`)

Every pharmacy page reads `web/src/services/mock/seed.ts` or an in-memory store. The real APIs
for most of them already exist.

| Page | Today | Real API | Gap |
|---|---|---|---|
| Orders | `ordersService` ← `mock/seed` `ORDERS`; status filter, fake flow | `GET /pharmacy/orders`; `POST /pharmacy/orders/:fulfillmentId/accept` · `decline` · `prepare` · `ready` (`order:fulfill:org`). The hand-over is the driver's `picked-up`, shown live from the order's status. | **Backend gap (Work 107):** the list returned only the fulfilment (ids, status, times), with no order number, lines, total or payment type. **Done:** the read in Work 107 (#60), and the portal page in Work 108. Its drawer shows what to prepare and moves the order on: accept or decline with a reason, start preparing, ready for pickup. After that the status follows the delivery. |
| Prescriptions (new page) | No page | `GET /pharmacy/verification/queue`, `GET /pharmacy/verification/:id`; `POST …/:id/approve` · `reject` · `clarify` (`prescription:verify`). The file opens through the audited preview (`POST /pharmacy/verification/:id/file`, Work 101). | **Backend gap (Work 109):** no product flow routed a prescription to any pharmacy's queue; only `staging:actors` did. **Done:** the routing in Work 109 (#62), and the portal page in Work 110. The pharmacist opens the file through the audited link and approves the items the customer asked for (quantity, refills, single use, two attestations), asks for clarification, or rejects with a reason. Customer checkout says the prescription is with the pharmacist. |
| Inventory | `inventoryService` ← `mock/seed` `INVENTORY` | `GET`/`POST`/`PATCH`/`DELETE /inventory/listings`; `POST /inventory/listings/:id/batches`; `PATCH /inventory/batches/:id` (adjust, reason required); `GET /inventory/listings/:id/movements` (`inventory:manage:org`) | Reservations visibility: the listing's `reserved` count is enough for Phase 1. No alerts or import route (module-04 §9.3). Low stock and near expiry are filters on the listing read, added if missing. **Backend gap (Work 111):** the list had no product names, and no read returned a listing's batches, which adjusting stock needs. **Done:** the read in Work 111 (#64), and the portal page in Work 112. It covers listings with on-hand, reserved and sellable stock, listing a catalogue product with its first batch, price and online sale, receiving a batch, an audited adjustment per batch, and the movement ledger. |
| Staff | `staffService` ← `mock/seed` `STAFF` | None | **Backend gap:** module-04 §9.2 `GET /pharmacy/staff`, `POST /pharmacy/staff/invite`, `DELETE /pharmacy/staff/:userId` (`staff:manage:org`) do not exist (Work 113). |
| Roles | `rolesService` ← `mock/seed` `ROLES`, editable custom roles | Pharmacy roles are the system catalogue (`PHARMACY_OWNER`, `PHARMACY_MANAGER`, `PHARMACIST`, `CASHIER`, `INVENTORY_STAFF`). The RBAC has no organisation-defined roles. | The page becomes a read-only view of what each pharmacy role may do, and staff get roles on the Staff page. Creating custom roles is not built, so not shown (Work 114). |
| Dashboard, Analytics | `analyticsService` ← `mock/seed` `ORDERS`, `INVENTORY` | None | **Backend gap:** module-04 §9.1 `GET /pharmacy/dashboard` (orders, revenue and stock health for the organisation) does not exist (Work 115). Analytics shows only what that read backs. |
| Reports | `reportsService`, an in-memory store of generated reports | `GET /settlements`, `GET /settlements/:id` (`settlement:read:org`) | Becomes **Statements**: the pharmacy's settlement statements and lines. Report generation without an API is removed (Work 116). |

When nothing imports them any more, Work 116 deletes `mock/seed.ts` and the six mock services
(`orders`, `inventory`, `staff`, `roles`, `analytics`, `reports`).

### Audit: the operations portal

- **Run a settlement statement:** `POST /admin/finance/settlements/run` exists; no page calls it.
- **Reconciliation report:** `GET /admin/finance/reconciliation` exists; no page shows it.
- **COD remittance:** `POST /admin/delivery/cod-reconciliation/:id/remit` exists; the portal's
  COD pages already show it.

Work 123 adds the first two to Finance. If Module 16's rules put running a statement behind
maker-checker, the action goes through an approval request.

### Audit: the customer app (deviation 2)

- A staff account's sign-in returns an MFA challenge, which the app reports as *unexpected
  response*.
- A Resend refusal shows *e-mail delivery is not set up*.

Work 124 gives each a clear message.

### Driver app

The design is in [driver-app.md](driver-app.md). Summary:
- a new `driver/` app in `app/`'s stack;
- e-mail and password sign-in (SMS is not available);
- availability, offers by polling within the 30-second TTL, the active job, live location through
  the existing tracking socket;
- PoD as the backend's rule requires;
- COD collection;
- earnings.

Remittance stays a finance action. **Backend gap (Work 117):** module-08 §9.1's
`PUT /driver/availability`, `GET /driver/profile` and `POST /delivery/location` do not exist; the
commands do.

**Staging accounts.** Pharmacy staff and drivers sign in with e-mail and password. Work 117:
- gives the walk's driver fixtures an e-mail address;
- lets `staging:set-password` set the passwords of the walk's pharmacy and driver accounts, as it
  does for finance.

### Decisions taken (recommended options, no owner decision needed)

1. The pharmacy hand-over to the driver is the driver's *picked up*. There is no separate pharmacy
   action, because none exists in module 06 or 08.
2. The pharmacy portal's Roles page shows the system pharmacy roles read-only; custom
   organisation roles are not part of the RBAC.
3. Pharmacy Reports becomes Statements. No report generation without an API.
4. Driver offers by polling (5 s) rather than a push channel.
5. COD remittance is recorded by finance; the driver app only shows it.
6. The driver app is online-first, with no offline action queue.

**Owner decision (2026-11-09): verify before paying.** When the customer opens checkout with a prescription item, the prescription goes to the pharmacy the checkout matched. That pharmacy's pharmacist approves or rejects it in the portal, and the customer then pays and orders from the same pharmacy. The pre-payment Rx gate stays, so a rejection needs no refund. The alternatives were verifying after the order (a rejection then needs a refund) and a platform pharmacist (module-05 Model B).

### Work plan

| Work | What |
|---|---|
| 106 | Housekeeping (PRs #2, #32), this audit, the driver app design |
| 107 | Backend: the pharmacy order read: the order header and lines on `GET /pharmacy/orders`, plus `GET /pharmacy/orders/:fulfillmentId` (found in Work 106's follow-up: the list had only fulfilment ids and status) |
| 108 | Pharmacy portal: orders and fulfilment on the real API |
| 109 | Backend: route a prescription to the matched pharmacy's review queue, and fill the order at the approving pharmacy (owner decision 2026-11-09: verify before paying). Nothing in the product flow ever called `AssignVerifyingPharmacyCommand`. |
| 110 | Pharmacy portal: prescription verification |
| 111 | Backend: the inventory read: product names on `GET /inventory/listings`, and `GET /inventory/listings/:id` with its batches, which receiving and adjusting stock need. Neither existed: the list had only product ids, and no read returned a batch id. |
| 112 | Pharmacy portal: inventory (listings, batches, receive and adjust, movements) |
| 113 | Backend: pharmacy staff (module-04 §9.2) |
| 114 | Pharmacy portal: staff and roles |
| 115 | Backend: pharmacy dashboard (module-04 §9.1) |
| 116 | Pharmacy portal: dashboard, analytics and statements; remove the mock seed |
| 117 | Backend: driver availability, profile and location (module-08 §9.1); walk accounts with e-mail and passwords |
| 118 | Driver app: scaffold, auth, CI |
| 119 | Driver app: availability and offers |
| 120 | Driver app: active job and live tracking |
| 121 | Driver app: proof of delivery |
| 122 | Driver app: COD and earnings |
| 123 | Operations portal: run a statement; reconciliation report |
| 124 | Customer app: staff-account and refused-e-mail messages |
| 125 | Live walk with every role in its own app; fix what breaks; close-out |

Backend gaps found while building a page get their own Work, inserted before that page's Work.
