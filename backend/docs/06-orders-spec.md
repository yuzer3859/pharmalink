# Module 06 — Cart, Checkout & Orders: Vertical Slice 1 Implementation Specification

**Slice:** Cart management + a reduced, COD-only checkout saga (Rx gate → matching → stock reservation → order creation) + Order lifecycle through pharmacy hand-off + pharmacy fulfillment actions + invoices.
**Status:** **DRAFT — NOT READY FOR IMPLEMENTATION.** This document narrows `architecture/module-06-cart-checkout-orders.md` into a buildable first slice, following the exact gate Modules 02/03/04/05 went through. It resolves five cross-module decision gates (§13) that the parent doc leaves open because it was written before Modules 05/07/08 existed in any concrete form. **No `backend/src` or `backend/prisma/schema` files were created or modified while preparing this document.**
**Parent design doc:** `architecture/module-06-cart-checkout-orders.md` (§1–10).
**Depends on:** Module 01 — Identity (RBAC, guards, audit — implemented, reused as-is). Module 02 — Profiles (`CustomerProfile`, address; `Beneficiary` — **not yet implemented**, see §13.4). Module 03 — Catalog (`ICatalogPort.getProduct()` — implemented). Module 04 — Pharmacy & Inventory (`IInventoryPort` reserve/release, `IAvailabilityPort`-style read — implemented). Module 05 — Prescription & Matching (Rx gate, matching — implemented, **but with an unexported matching capability**, see §13.1). **Consumed by (future):** Module 07 (Payment — non-COD authorization), Module 08 (Delivery — dispatch/tracking), Module 13 (Notifications), Module 15 (Reviews, post-`COMPLETED`).
**Traceability:** BR-ORD-01..12 (partial — see §0.2), FR-ORD-01..10 (partial), FR-MED-10, BRULE-17 (partial — COD path only), BRULE-19, BRULE-20, BRULE-21, NFR-AUDIT.

---

## 0. Scope

### 0.1 Slice 1 in scope
- **Cart** — add/update/remove items, live totals against real Module 03/04 data, Rx flagging (cached from `ICatalogPort`), validation at checkout.
- **Checkout — COD-only saga** — cart validation → Rx gate (Module 05) → matching (Module 05) → stock reservation (Module 04) → order creation with immutable snapshots. **No payment-gateway authorization step exists in Slice 1** — every Slice-1 order is `isCod = true` (BR-ORD-05's "except COD where enabled" branch is the *only* branch built now); see §13.2.
- **Order lifecycle through pharmacy hand-off** — `DRAFT → PENDING_PAYMENT → PAID → ACCEPTED → PREPARING → READY`, plus `CANCELLED`/`REFUNDED` branches reachable pre-dispatch. This is the actual Prisma `OrderStatus` enum (§6.6), not the parent doc's 11-state narrative — see §13.3 for the reconciliation.
- **Pharmacy fulfillment actions buildable now** — accept, decline (→ re-match via Module 05), prepare, mark ready. These dispense stock (Module 04 `IInventoryPort.dispatch()`) and consume the approved prescription line (Module 05 `IDispensingPort.dispense()`) — the two ledger-writing integrations this module was built to orchestrate.
- **Cancellation** — customer-initiated, pre-`DISPATCHED`-equivalent (i.e. before `READY`'s stock has left the building — Slice 1's furthest reachable state is `READY`, so in practice "before `READY`"), releasing the Module 04 reservation.
- **Invoice generation** — a persisted `Invoice` row with a computed `totals` JSON snapshot at order placement. **No PDF rendering** (`pdfRef` stays null in Slice 1 — no `IStoragePort` exists, same constraint Module 05 §2.3 already documented; this module does not become the first to build one either).
- **Ownership/tenant scoping, RBAC, audit, and outbox** for every command above.

### 0.2 Explicitly out of scope for this slice
| Deferred item | Why deferred | Covered by |
| --- | --- | --- |
| Non-COD payment authorization (`paymentMethod`, `useWallet`, `couponCode`, `PAYMENT_FAILED`) | Module 07 (Payment) does not exist in this repository (`src/modules/payment/` absent) | Module 06 — Slice 2, once Module 07 lands |
| Delivery hand-off (`DISPATCHED → DELIVERED`, delivery job creation, real-time tracking) | Module 08 (Delivery & Tracking) does not exist (`src/modules/delivery/` absent) — confirmed against `architecture/00-architecture-index.md`'s numbering, which places Delivery at **08**, not 09 (09 is Provider Directory, an unrelated Phase-2 module) | Module 06 — Slice 2, once Module 08 lands |
| Split fulfillment / multi-pharmacy `Fulfillment` rows per order / substitution consent flow | Module 05 Slice 1 already defers split-pharmacy matching (`05-prescription-matching-spec.md` §0.2) — Module 06 cannot split an order across pharmacies that Module 05 itself cannot match to. `OrderStrategy.SPLIT` and `OrderLineStatus.SUBSTITUTED` remain schema-level, unreachable values (mirrors Module 05's own `MatchStatus.PARTIAL` precedent) | Module 06 — Slice 2, coordinated with Module 05 Slice 2 |
| Beneficiary-scoped checkout (diaspora orders, BR-ORD-15/BRULE-21's beneficiary half) | `Beneficiary` is not implemented in Module 02 (confirmed: no references anywhere in `src/modules/profiles/`) | Module 06 — Slice 2, coordinated with Module 02 Slice 2/4 (identical deferral Module 05 §2.2 already made) |
| `PENDING_VERIFICATION` as a persisted `Order` sub-state | Not needed even in Slice 2, in fact — see §13.3: Module 05's `PrescriptionGate` checks an *already-approved* line at checkout time (pre-order-creation), so there is no "order waiting on Rx verification" state to model. Verification happens on the `Prescription` aggregate (Module 05), not the `Order` aggregate. | N/A — resolved, not deferred |
| Scheduled/future delivery slot selection (`deliverySlot`) | Column exists (`Order.deliverySlot`) and is accepted opaquely from the client (free-text string) but not validated against any real availability calendar — no such calendar exists yet | Module 06 — Slice 2 or Module 08, whichever owns delivery-window capacity |
| PDF invoice rendering | No `IStoragePort` exists anywhere in the codebase (Module 05 §2.3's identical finding) | Module 06 — Slice 2, alongside Module 05's own deferred file-upload work, per Module 05 §20 Decision 1's "solve once, centrally" recommendation |
| Admin force-cancel, admin order search | Not required for the customer/pharmacy happy path; `admin:manage` already exists and is sufficient to gate a Slice-2 route without a new permission | Module 06 — Slice 2 |
| Rating/review linkage on `COMPLETED` | `COMPLETED` is unreachable in Slice 1 (requires `DELIVERED`, which requires Module 08) | Module 06 — Slice 2, after Module 08 |

### 0.3 Definition of done for this slice
A customer can add OTC and Rx items to a cart, run `/checkout/quote` to see a real Rx-gate + matching result, complete a COD `/checkout` that atomically creates an `Order` with immutable snapshots and a real Module 04 stock reservation, have a pharmacist at the matched pharmacy accept/decline (triggering re-match) the order, prepare it (dispensing against the approved prescription line and reserving-then-dispatching the stock), and mark it `READY` — with an itemized invoice row, full audit trail, outbox events, and a cancellation path — all through permission-guarded, audited, envelope-consistent, transactionally-atomic endpoints, tested per §12, matching the hardening pattern established in Modules 02–05.

---

## 1. Functional Requirements Covered (Slice 1)

| ID | Requirement | Slice 1 coverage |
| --- | --- | --- |
| BR-ORD-01 | Add/update/remove cart items | ✅ `AddToCartCommand`/`UpdateCartItemCommand`/`RemoveCartItemCommand` |
| BR-ORD-02 | Totals include item price + delivery + fees | ✅ computed at quote/checkout time from real Module 03 prices + a flat/config-driven delivery fee and platform fee (no distance-based delivery pricing yet — no geo-fee model exists in any module) |
| BR-ORD-03 | Checkout selects delivery address (+ beneficiary) | ⚠️ address only — `addressId` resolved via a Module 02 `IAddressPort` (own copy); `beneficiaryId` accepted opaquely, unenforced (§0.2) |
| BR-ORD-04 | Rx items blocked without valid prescription | ✅ `ICheckRxGatePort` (Module 05), called at both `/checkout/quote` and `/checkout` |
| BR-ORD-05 | Order confirmed only after payment authorization (except COD) | ⚠️ **COD only** in Slice 1 — every order *is* the COD exception; non-COD path is a Slice-2 item (§13.2) |
| BR-ORD-06 | Order status lifecycle | ✅ reduced state machine (§3.4/§13.3) |
| BR-ORD-07 | View order status/history | ✅ `GetOrderQuery`/`ListOrdersQuery`, backed by `OrderStatusHistory` |
| BR-ORD-08 | Cancellation within rules | ✅ pre-`READY` only (§3.5) |
| BR-ORD-09 | Notify parties at each status change | ⏸ Outbox events fire (§8); direct notification delivery is Module 13's responsibility, unchanged from Module 05's own BR-RX-05 conclusion — **no code added here either** |
| BR-ORD-10 | Pharmacy accept/prepare/mark ready | ✅ `AcceptFulfillmentCommand`/`DeclineFulfillmentCommand`/`PrepareFulfillmentCommand`/`MarkReadyCommand` |
| BR-ORD-11 | Itemized receipt/invoice | ⚠️ data row only, no PDF (§0.2) |
| BR-ORD-12 | Scheduled delivery slot | ⚠️ opaque passthrough only (§0.2) |
| BR-ORD-13 | Partial fulfillment/substitution | ⏸ Deferred (§0.2) |
| BR-ORD-14 | Re-match on decline | ✅ `DeclineFulfillmentCommand` calls Module 05's `RematchCommand` (via the port resolved in §13.1) |
| BR-ORD-15 | Diaspora beneficiary + address | ⚠️ address only (§0.2) |

---

## 2. Dependency Matrix

| Module | Dependency | Available? | Slice-1 treatment |
| --- | --- | --- | --- |
| 01 Identity | `JwtAuthGuard`/`PermissionsGuard` (global), `AuditService`, error envelope, `user_roles`/`roles` for a Module-06-owned `IIdentityPort` copy | ✅ verified — same infra every prior module reused | Reused as-is |
| 02 Profiles | Address resolution for delivery address | ✅ verified — `CustomerProfile`/`Address` exist and are queryable | Own-copy `IAddressPort` reads `Address` directly (mirrors Module 05's `ICatalogPort` own-copy discipline) |
| 02 Profiles | `Beneficiary` | ❌ verified absent (`grep` for `Beneficiary` under `src/modules/profiles/` returns nothing) | Opaque, unenforced `beneficiaryId` (§0.2, §13.4) |
| 03 Catalog | `ICatalogPort.getProduct()` (price, `rxClassification`, `ACTIVE` status) for cart pricing | ✅ verified implemented; `CatalogModule` exports nothing (confirmed — no `exports:` in `catalog.module.ts`), consistent with every consumer building its own adapter | Module 06 builds its own `ICatalogPort` copy (own `PrismaService` read of `Product`), per ADR-002 — same as Modules 04/05 |
| 04 Pharmacy/Inventory | `IInventoryPort` (reserve/release/confirm/dispatch) | ✅ verified — `PharmacyInventoryModule` exports `INVENTORY_PORT` and `GetAvailabilityQuery` explicitly, and its own module doc comment already anticipates "Module 06, later" as a consumer | Direct DI injection via `imports: [PharmacyInventoryModule]`, exactly like Module 05 does — **not** re-wrapped in another port (same reasoning Module 05 §2.1 gave for not wrapping `IInventoryPort` a second time) |
| 05 Prescription/Matching | `ICheckRxGatePort` | ✅ verified exported (`exports: [CHECK_RX_GATE_PORT, DISPENSING_PORT]`) | Direct DI injection via `imports: [PrescriptionMatchingModule]` |
| 05 Prescription/Matching | `IDispensingPort` | ✅ verified exported | Direct DI injection, called from `PrepareFulfillmentCommand` |
| 05 Prescription/Matching | Matching capability (find/select/rematch) | ❌ **verified NOT exported** — `FindMatchCommand`/`SelectMatchCommand`/`RematchCommand`/`GetMatchResultQuery` are registered providers in `prescription-matching.module.ts` but absent from its `exports` array | **Decision-required** — see §13.1. Blocks `CheckoutSaga`/`DeclineFulfillmentCommand` until resolved. |
| 07 Payment | Payment authorization, wallet, coupons | ❌ verified absent (`src/modules/payment/` does not exist) | COD-only Slice 1 (§13.2); `IPaymentPort` is *documented*, not built (§5.6) |
| 08 Delivery | Delivery job creation, dispatch, tracking | ❌ verified absent (`src/modules/delivery/` does not exist) | Order lifecycle stops at `READY` (§13.3); no delivery port built |
| Shared | `OutboxService`/`AuditService`/`EventBusService` | ✅ verified `@Global()` from `SharedModule`, reused as-is | No new infra |
| Shared | `IConfigPort` | ✅ verified (`shared/config/config.port.ts`), reused as-is for fee/window config, same namespacing convention Module 05 used (`matching.rankingWeights`) | New keys: `orders.deliveryFeeFlat`, `orders.platformFeePercent`, `orders.cancellationWindowMinutes` |

---

## 3. Domain Model

### 3.1 Cart (aggregate root)
Existing Prisma model (`06-orders.prisma`) reused as-is. One `ACTIVE` cart per `(customerUserId, beneficiaryId)` pair — Slice 1 collapses this to one `ACTIVE` cart per `customerUserId` since `beneficiaryId` is unenforced (§13.4); a partial unique index scoped to `beneficiaryId IS NULL` would be the eventual Slice-2 shape, not built now (no schema change in this task).

### 3.2 CartItem (entity)
Existing model reused as-is. `requiresRx` is a **cached** boolean copied from `ICatalogPort.getProduct().rxClassification` at add-time (mirrors Module 04's `sellable` cache pattern, ADR-006) — re-validated fresh at `/cart/validate` and at checkout, never trusted stale.

### 3.3 Order (aggregate root)
Existing model reused as-is, with one adjustment to expectations, not schema: `paymentId` stays `null` for every Slice-1 order (no Module 07), and `isCod` is always `true` (§0.1). `beneficiarySnapshot` is written as `null` (§13.4) — not an empty object, so a future Slice-2 reader can distinguish "no beneficiary selected" from "beneficiary feature not built yet at order time" (a real forward-compatibility concern, since orders are permanent audit records).

### 3.4 Order status — reconciling the parent doc's 11 states against the actual schema
**Finding:** `06-orders.prisma`'s `OrderStatus` enum is:
```prisma
enum OrderStatus {
  DRAFT
  PENDING_PAYMENT
  PAID
  ACCEPTED
  READY
  DISPATCHED
  DELIVERED
  COMPLETED
  CANCELLED
  REFUNDED
}
```
— **10 values**, not the parent doc §4's 11-state prose (`... → PENDING_VERIFICATION → ACCEPTED → PREPARING → READY_FOR_PICKUP → DISPATCHED → OUT_FOR_DELIVERY → ...`, terminal branches `CANCELLED, REFUNDED, PARTIALLY_FULFILLED, FAILED`). This is confirmed schema-vs-parent-doc drift, the same category of finding as Module 05's own `CONSUMED` gap (§6.2 of that spec) — except here the **schema is already correct and complete enough for Slice 1**, and the parent doc's richer narrative simply names sub-states this codebase doesn't persist:
- **`PENDING_VERIFICATION`** — not needed. Module 05's `PrescriptionGate`/`ICheckRxGatePort` checks an *already-approved, non-expired, non-exhausted* `PrescriptionLine` **before** the order is ever created (at `/checkout/quote` and `/checkout`) — there is no "order is waiting on a pharmacist to review" state, because by construction an order is never created for an Rx line that lacks an approved line already. Resolved, not deferred (§0.2).
- **`PREPARING`** — not a persisted `Order.status` value; Slice 1 tracks it on `Fulfillment.status` (which *does* have `PREPARING` in its own enum, §3.6) instead. `Order.status` stays `ACCEPTED` while the single Slice-1 fulfillment moves `ACCEPTED → PREPARING → READY`; `Order.status` itself advances to `READY` only once every fulfillment (just one, in Slice 1's single-pharmacy world) reaches `READY`.
- **`READY_FOR_PICKUP`** — schema's `READY` is this value under a shorter name. Adopted as-is (no schema change).
- **`OUT_FOR_DELIVERY`** — does not exist as a distinct `Order.status`; `DISPATCHED` covers "handed to delivery" and `DELIVERED` covers "customer received it." A finer-grained "rider en route" signal belongs to Module 08's own delivery-job status, not `Order.status` — **deferred to Module 08**, not resolved now, since it requires a module that doesn't exist.
- **`PARTIALLY_FULFILLED`** — does not exist; not needed, since split fulfillment itself is deferred (§0.2). Mirrors `MatchStatus.PARTIAL`'s precedent in Module 05 (schema-adjacent value with no Slice-1 role) — except here the value doesn't even exist in the enum, so there's nothing to leave inert.
- **`FAILED`** — does not exist; the parent doc's own transition table never actually routes into it (payment failure/timeout goes straight to `CANCELLED`, §4 row 2) — its absence from the schema costs Slice 1 nothing.

**Slice-1 reachable transitions** (a strict subset of the schema's 10 values):
| From | Event | To | Guard |
| --- | --- | --- | --- |
| `DRAFT` | checkout submitted | `PENDING_PAYMENT` | Rx gate passed, matching succeeded, address resolved |
| `PENDING_PAYMENT` | COD confirmed (immediate, no gateway round-trip) | `PAID` | `isCod = true` (always true in Slice 1) — stock already reserved in the same saga |
| `PENDING_PAYMENT` | reservation/order-creation failure | `CANCELLED` | saga compensation (§4) |
| `PAID` | pharmacy accepts | `ACCEPTED` | reviewer holds `order:fulfill:org` at the fulfilling pharmacy's org (mirrors Module 05's `VerificationPolicy` org-check) |
| `PAID`/`ACCEPTED` | pharmacy declines / timeout (no sweeper in Slice 1, no concrete trigger exists yet — mirrors Module 05 §8.4's identical "no speculative sweeper" reasoning) | re-match (stays `PAID`, no status change) or `CANCELLED` if `RematchCommand` exhausts candidates | BRULE-19 |
| `ACCEPTED` | begins prep (fulfillment-level only, §3.6) | `ACCEPTED` (unchanged) | — |
| `ACCEPTED` | all fulfillments ready | `READY` | stock dispensed (Module 04 `dispatch()` + Module 05 `dispense()`) |
| any pre-`READY` | customer cancels | `CANCELLED` | within `orders.cancellationWindowMinutes` (config), BRULE-20 |
| `READY` | *(Slice 1 stops here — no further transition is implementable without Module 08)* | — | — |

`DISPATCHED`, `DELIVERED`, `COMPLETED`, `REFUNDED` remain schema-level, unreachable-in-Slice-1 values — explicitly documented, not silently ignored, mirroring exactly how Module 05 treated `MatchStatus.PARTIAL`.

### 3.5 Cancellation policy
`CancellationPolicy` (VO, pure): `canCancel(status: OrderStatus): boolean` — `true` for `DRAFT, PENDING_PAYMENT, PAID, ACCEPTED`; `false` for `READY` and beyond. No time-window VO is added beyond this status check in Slice 1 — the parent doc's "before dispatch" (BRULE-20) collapses to "before `READY`" given Slice 1's reachable-state ceiling.

### 3.6 Fulfillment (entity)
Existing model reused as-is. Exactly **one** `Fulfillment` per `Order` in Slice 1 (split fulfillment deferred, §0.2) — created at order-placement time from the single `MatchRequest.chosenResult` (Module 05). `FulfillmentStatus` reachable subset: `PENDING → ACCEPTED → PREPARING → READY`; `DISPATCHED`/`DELIVERED` deferred to Module 08; `CANCELLED` reachable via decline.

### 3.7 OrderLine (entity)
Existing model reused as-is. `prescriptionLineId` is populated **only** for Rx lines, set to the `PrescriptionLine.id` that `ICheckRxGatePort.check()` returned as the `usablePrescriptionLineIds` match for that `catalogProductId` — this is the join `PrepareFulfillmentCommand` needs to call `IDispensingPort.dispense()` per line. `reservationId` is populated from Module 04's `IInventoryPort.reserve()` result. `substitutedFromProductId`/`OrderLineStatus.SUBSTITUTED` remain unreachable (§0.2).

### 3.8 OrderStatusHistory (immutable ledger)
Existing model reused as-is — one row per `Order.status` transition (ADR-006 append-only-ledger discipline), written in the same transaction as the status change.

### 3.9 Invoice (entity)
Existing model reused as-is. Written once, at order placement, in the same transaction. `totals` (JSON) = `{ subtotal, deliveryFee, platformFee, discountTotal, grandTotal, currency, lines: [{catalogProductId, quantity, unitPrice, lineTotal}] }`. `pdfRef` stays `null` (§0.2).

### 3.10 Value objects
- `OrderStatus`/`FulfillmentStatus`/`OrderLineStatus`/`CartStatus`/`OrderStrategy` — re-exported Prisma enums (`domain/enums.ts`), same convention as Modules 02–05.
- `Money` — reuses ADR-005's integer-minor-units-plus-currency convention; a thin `computeTotals(lines, deliveryFee, platformFee, discountTotal): OrderTotals` pure function, not a full VO class (mirrors how Module 05 kept `RemainingDispensable` minimal).
- `CancellationPolicy` — see §3.5.
- `AddressSnapshot`/`PriceSnapshot` — plain, frozen-at-write JSON shapes (`{ line1, city, lat, lng }` / `{ catalogProductId, unitPrice, name }`), not VO classes — they exist only to be copied verbatim into `Order.addressSnapshot`/`OrderLine.productSnapshot`, no behavior of their own.

### 3.11 Domain services
- **`OrderStateMachine`** — `assertValidTransition(from: OrderStatus, to: OrderStatus): void`, pure, mirrors `PrescriptionStatusPolicy`/`MatchStatusPolicy`'s exact shape and `INVALID_ORDER_STATE_TRANSITION` error convention (§10).
- **`CancellationPolicyService`** (or a bare function, given its simplicity — final call left to the implementer) — wraps §3.5.
- **`PricingCalculator`** — `computeTotals(...)`, pure, unit-testable with fixed fixtures, no DB.

### 3.12 Invariants (safety-critical)
1. An `Order` reaches `PENDING_PAYMENT` only after `ICheckRxGatePort.check()` returns `allowed = true` for every Rx line and a real Module 04 reservation exists for every line (§4 step 4) — never created speculatively.
2. `Order.grandTotal` is computed once, at placement, from real Module 03 prices read fresh inside the same transaction — never trusted from a stale cart-level cache (mirrors Module 05's "recompute inside the transaction" discipline, §3.11.3 of that spec). Concretely: the authoritative unit price is `ICatalogPort.getProduct().price` — Catalog's **reference** price (`products.price`), not `InventoryListing.price` and **not** `CartItem.indicativePrice`. `indicativePrice` is a display-time cache written when the item was added to the cart and refreshed by `/cart/validate`/`/checkout/quote`; it is **never** consulted for the order total. It has exactly one role at checkout: it is the **confirmation baseline** for §10's `PRICE_CHANGED` — step 1 compares it against the fresh Module 03 read and rejects with `409 PRICE_CHANGED` when they diverge, so a customer is never silently charged more than the amount they last confirmed (parent doc §5.3, "customer never charged more than confirmed"). Once the client re-quotes, the order is priced from the *current* catalog read, not the cache. `OrderLine.unitPrice` then snapshots that checkout-time value immutably (§3.11 invariant 1).
3. Every `Order.status` transition is guarded by `OrderStateMachine` and appends exactly one `OrderStatusHistory` row in the same transaction — no ad-hoc mutation (parent doc §5.3, reused verbatim).
4. A `Fulfillment` reaches `READY` only after `IDispensingPort.dispense()` has succeeded for every Rx `OrderLine` on it and `IInventoryPort.dispatch()` has succeeded for every line on it — mirrors Module 05's own dispense-ledger discipline; `Order.status → READY` cascades only once every `Fulfillment` (one, in Slice 1) is `READY`.
5. Cancellation releases every reservation the order holds via `IInventoryPort.release()`, so an order is not left `CANCELLED` with stock still reserved against it. That release is a **cross-module, best-effort** call in Module 04's own transaction, outside `CancelOrderCommand`'s local one — the accepted ADR-014 eventual-consistency seam, not an atomic rollback.

   **No TTL fallback applies here.** Since checkout confirms every reservation at `PENDING_PAYMENT → PAID` (§4 step 7b), an order that can be cancelled holds `CONFIRMED` reservations, and Module 04's reservation TTL sweeper (ADR-007) only expires **`HELD`** ones. If the release call fails, that reservation is therefore *not* reclaimed automatically: it stays `CONFIRMED` and continues to hold stock until someone releases it explicitly. This is a known, accepted orphan risk of the Slice-1 seam, stated here rather than papered over — no reconciliation sweeper or compensating job exists for it in Slice 1, and none is proposed by this document.

---

## 4. Checkout Saga (Slice 1 — reduced, COD-only)

The parent doc's 8-step saga (§6) assumes Module 07 exists for step 7. Slice 1's saga is steps 1–6 and 8, with step 7 (payment authorization) **replaced by an immediate COD confirmation** — no external call, no port, no gateway:

| Step | Action | Compensation on later failure | Transaction |
| --- | --- | --- | --- |
| 1 | Validate cart — refresh prices/`rxClassification` from `ICatalogPort` fresh | — | read-only, no lock |
| 2 | Rx gate — `ICheckRxGatePort.check()` (Module 05) | abort → `RX_REQUIRED` | read-only |
| 3 | Matching — via the port resolved in §13.1 (Module 05) | abort → `NO_PHARMACY_MATCH` | Module 05's own transaction (already `Serializable`, ADR-013) |
| 4 | Reserve stock — `IInventoryPort.reserve()` per line (Module 04) | release on any later step's failure | Module 04's own transaction (`Read Committed` + `FOR UPDATE`, per Module 04's own spec — an accepted, documented ADR-014 seam, identical to how Module 05's `SelectMatchCommand` already treats this exact call) |
| 5 | Compute totals — `PricingCalculator` (no coupons/wallet — Module 07 absent) | — | in-memory, pure |
| 6 | Create `Order` `PENDING_PAYMENT` + `OrderLine`s + `Fulfillment` + `Invoice` + snapshots, in **this module's own** `Serializable` transaction with bounded retry (own copy, `runWithOrderRetry`, per ADR-002/ADR-013 — not a cross-module import of Module 05's `runWithMatchRetry`) | on failure, release step-4's reservations (best-effort, mirrors Module 05's `SelectMatchCommand` partial-rollback pattern) | `Serializable` + bounded retry |
| 7 | ~~Authorize payment~~ | **replaced**: no-op for `isCod = true` (the only value in Slice 1) | — |
| 7b | Confirm each reservation `HELD → CONFIRMED` — `IInventoryPort.confirm()` per line (Module 04 §8's "confirm on payment success"; for COD, payment success *is* step 8's `PENDING_PAYMENT → PAID`, so this is that moment). Runs **before** step 6's transaction and outside it: it is a cross-module call owning its own transaction (ADR-014) that must not be replayed by `runWithOrderRetry`, and leaving the hold `HELD` any longer would let Module 04's TTL sweeper expire it out from under a paid order | on failure, release this attempt's reservations (`ReleaseReservationCommand` accepts `CONFIRMED` as readily as `HELD`), then abort | Module 04's own transaction |
| 8 | Confirm → `Order.status: PENDING_PAYMENT → PAID` (same transaction as step 6, since there is no external payment round-trip to wait on) + audit + outbox `OrderPlaced`/`OrderPaid` | — | same transaction as step 6 |

**Ordering rationale for steps 3→4** (ADR-014, reused verbatim from Module 05 §12): matching's `SelectMatchCommand` already reserves stock **before** flipping `MatchRequest.status → MATCHED` — Module 06's checkout saga calls that already-atomic sequence as one step (step 3+4 are, from Module 06's perspective, a single call into Module 05's `SelectMatchCommand`, not two separate calls Module 06 orchestrates itself). This avoids Module 06 re-deciding an ordering question Module 05 already resolved and owns.

**Idempotency.** `POST /checkout` requires a client-supplied `idempotencyKey` **DTO field** (not an HTTP header + interceptor, per §13.5's decision) — a replay with the same key returns the original `Order`, never creates a second one, enforced by `Order.idempotencyKey`'s existing `@unique` schema constraint (already present, no migration needed) exactly like Module 04's `ReserveStockDto.idempotencyKey`/Module 05's `DispenseMedicineInput.idempotencyKey`.

**Failure/compensation summary:**
| Failure point | Compensation |
| --- | --- |
| Rx gate blocks | No reservation ever made — nothing to compensate |
| No pharmacy match | No reservation ever made — nothing to compensate |
| Reservation succeeds, order-creation transaction fails | Best-effort `IInventoryPort.release()` for each reservation made this attempt (ADR-014 — Module 04's own transaction, never rolled back by ours). By this point step 7b has already confirmed those reservations, so Module 04's TTL sweeper (ADR-007, `HELD` only) is **not** a fallback for them: a failed release leaves a `CONFIRMED` reservation holding stock, the same accepted orphan risk §3.12 invariant 5 documents |
| Order created, retry-exhaustion `CONFLICT` (5 attempts, ADR-013) | Same as above — release, then surface `409 CONFLICT` |

---

## 5. Cross-Module Ports (own copies, ADR-002)

- **`ICatalogPort`** (own copy) — `getProduct(productId): Promise<{id, status, rxClassification, price, name} | null>`. Direct `PrismaService` read of `Product`, mirroring Module 04/05's own copies exactly (not a shared import). `price` is Catalog's **reference** price (`products.price`, ADR-015) — Module 06 stores no price of its own and is never a second pricing source. Because that column is nullable and `CatalogProductView.price` is not, the adapter returns **`null` for an unpriced product**, exactly as it does for a soft-deleted one: an unpriced product is *not purchasable*, and checkout rejects it through the existing `catalogProductUnavailable()` / `CATALOG_PRODUCT_NOT_FOUND` branch rather than pricing a line at zero.
- **`IIdentityPort`** (own copy) — `hasRoleAtOrganization(userId, organizationId, roleKey): Promise<boolean>` — needed for `order:fulfill:org` org-scoping on `AcceptFulfillmentCommand`/`PrepareFulfillmentCommand`/`MarkReadyCommand`, identical shape/purpose to Module 05's copy.
- **`IAddressPort`** (own copy, new) — `getAddress(addressId, customerUserId): Promise<{lat, lng, line1, city} | null>` — direct `PrismaService` read of Module 02's `Address` model, ownership-checked in the same call (mirrors the `ICatalogPort` own-copy pattern; Module 02 exports nothing today, same situation Module 03 was already in for Modules 04/05).
- **`IInventoryPort`** — **not** a Module 06 port; `PharmacyInventoryModule` imported directly, `INVENTORY_PORT` injected as-is (§2).
- **`ICheckRxGatePort`** / **`IDispensingPort`** — **not** Module 06 ports; `PrescriptionMatchingModule` imported directly, both tokens injected as-is (§2).
- **Matching capability** — see §13.1's decision gate; the resulting contract (whatever shape it takes) is injected the same way, once Module 05 exposes it.
- **`IPaymentPort`** — **documented only, not created as a file in this task** (per the strict rule against inventing unimplemented production code). Its eventual Slice-2 shape, so a future implementer doesn't re-derive it from scratch:
  ```ts
  interface IPaymentPort {
    authorize(input: { orderId: string; amount: number; currency: string; method: string }):
      Promise<{ paymentId: string; status: 'AUTHORIZED' | 'FAILED' }>;
  }
  ```
  Slice 1's `CheckoutSaga` has no reference to this interface at all — not a stub, not a no-op implementation, nothing. It is pure documentation of intent for whoever builds Module 07.
- **`IConfigPort`** — reused from `shared/`, new keys: `orders.deliveryFeeFlat` (int, minor units), `orders.platformFeePercent` (number, 0–1), `orders.cancellationWindowMinutes` (int — informational only in Slice 1 since §3.5's policy is status-based, not time-based; reserved for a Slice-2 time-boxed policy).

---

## 6. Prisma/Schema Mapping

`06-orders.prisma` already exists and requires **no schema changes** for Slice 1 — every field Slice 1 needs is already present:

| Slice-1 entity | Schema model | Gaps |
| --- | --- | --- |
| Cart | `Cart` | none |
| CartItem | `CartItem` | none |
| Order | `Order` | none — `paymentId` stays null, `isCod` always true, `matchRequestId` populated from Module 05 |
| OrderLine | `OrderLine` | none |
| Fulfillment | `Fulfillment` | none |
| OrderStatusHistory | `OrderStatusHistory` | none |
| Invoice | `Invoice` | none — `pdfRef` stays null |

**Discrepancy documented, not fixed (§3.4):** the parent doc's 11-state `OrderStatus` narrative does not match the actual 10-value Prisma enum. Resolved as a **reconciliation, not a required migration** — unlike Module 05's `CONSUMED` gap, nothing Slice 1 needs is actually missing from the schema; the parent doc's finer-grained sub-states either map onto existing values (`READY_FOR_PICKUP` → `READY`) or are handled at a different aggregate (`PENDING_VERIFICATION` → Module 05's `Prescription.status`, checked pre-order) or a different entity (`PREPARING` → `Fulfillment.status`, not `Order.status`). **No Prisma changes are proposed by this document.**

No indexes are proposed as required-before-implementation (unlike Module 05 §6.4) — `Order.idempotencyKey`/`orderNumber` already have `@unique` (which Postgres backs with an index), and Slice-1 data volumes don't yet justify a `customerUserId`/`status` composite index; revisit if `ListOrdersQuery` needs it once real usage data exists.

---

## 7. RBAC

### 7.1 Already seeded, already correct — no change needed
**Finding:** `prisma/rbac-catalog.ts` already contains every permission Slice 1 needs, pre-seeded ahead of this module exactly like `prescription:upload:own`/`prescription:verify` were pre-seeded ahead of Module 05 (§7.1 of that spec):
| Key | Granted to | Slice-1 use |
| --- | --- | --- |
| `order:create:own` | `CUSTOMER` | `POST /checkout` |
| `order:read:own` | `CUSTOMER` | `GET /orders`, `GET /orders/:id`, `GET /orders/:id/invoice` |
| `order:read:org` | `PHARMACY_OWNER`, `PHARMACY_MANAGER`, `PHARMACIST`, `CASHIER` | `GET /pharmacy/orders` |
| `order:fulfill:org` | `PHARMACY_OWNER`, `PHARMACY_MANAGER`, `PHARMACIST` | accept/decline/prepare/ready |

**No new permission is required for Slice 1.** Cart routes (`/cart/*`) need no dedicated permission beyond authentication + implicit ownership (mirrors how Module 04's own-resource routes work) — `order:create:own` is the natural gate for `/checkout` itself, and cart mutation is a strict subset of "things a customer can do before creating an order," so reusing `order:create:own` for `/cart/*` as well (rather than minting a redundant `cart:manage:own`) is the Slice-1 recommendation, open for review at implementation time.

### 7.2 Explicitly not added in Slice 1
No `order:cancel:own` — cancellation is a state-guarded action on an already-owned resource (`order:read:own` + `OrderStateMachine`'s guard is sufficient, mirroring how Module 05 never minted a separate permission for `reupload` beyond `prescription:upload:own`). No admin permission changes — `admin:manage` already exists and is sufficient once Slice-2 admin routes are built.

---

## 8. Domain Events (Slice 1)

Per `00-domain-event-catalog.md`'s Module 06 row (`OrderPlaced`, `OrderPaid`, `OrderAccepted`, `OrderReady`, `OrderDispatched`/`OrderDelivered`, `OrderCompleted`, `OrderCancelled`) — **Slice 1 emits only the subset reachable given §3.4's state ceiling**:

| Event | Payload | Trigger | Slice 1? |
| --- | --- | --- | --- |
| `OrderPlaced` | `{ orderId, customerUserId, totals }` | Checkout saga step 6 | ✅ |
| `OrderPaid` | `{ orderId, paymentId }` | Checkout saga step 8 (COD: `paymentId: null`) | ✅ — `paymentId` is `null`/absent until Module 07 exists, same documented nullability pattern Module 05 §9 used for `OrderMatched.orderId` pre-Module-06 |
| `OrderAccepted` | `{ orderId, fulfillmentId, pharmacyId }` | `AcceptFulfillmentCommand` | ✅ |
| `OrderReady` | `{ orderId, fulfillmentId }` | `MarkReadyCommand` (cascades from every fulfillment reaching `READY`) | ✅ |
| `OrderCancelled` | `{ orderId, reason }` | `CancelOrderCommand` | ✅ |
| `OrderDispatched` / `OrderDelivered` | `{ orderId }` | Module 08 hand-off | ❌ **not emitted in Slice 1** — no trigger exists (mirrors Module 05 §0.2's "no speculative event with no cataloged consumer" discipline, applied here to "no reachable trigger" instead) |
| `OrderCompleted` | `{ orderId }` | post-`DELIVERED` confirmation | ❌ not emitted — unreachable state |

A `RematchRequested`-shaped signal (parent doc §9's folder listing) is **not** a new Module 06 event — a decline simply calls into Module 05's already-cataloged `RematchTriggered`/`MatchFailed` events (§13.1); Module 06 does not duplicate them.

Every event is written to `outbox` in the same transaction as its triggering state change (ADR-010), reusing `OutboxService.write()` — no new outbox infrastructure, identical to every prior module.

---

## 9. API Surface (Slice 1)

Base paths per the parent doc §8: `/api/v1/cart`, `/api/v1/checkout`, `/api/v1/orders`, `/api/v1/pharmacy/orders`. Bearer auth via global guards; envelope/errors per `00-shared-conventions.md` §1. No `@Public()` routes.

### 9.1 Cart (customer, gated by `order:create:own` per §7.1)
- **GET `/cart`** → `200 { id, items[], totals }`.
- **POST `/cart/items`** — `{ catalogProductId, quantity }` → `201` (beneficiaryId omitted, §0.2).
- **PATCH `/cart/items/:id`** — `{ quantity }` → `200`.
- **DELETE `/cart/items/:id`** → `200`.
- **DELETE `/cart`** → `200` (clear).
- **POST `/cart/validate`** → `200 { items: [{..., priceChanged, stillAvailable}], readyForCheckout }`.

### 9.2 Checkout (customer, `order:create:own`)
- **POST `/checkout/quote`** — `{ addressId, deliverySlot? }` → `200 { rxGateResult, candidates, totals }`. No order created. Errors: `RX_REQUIRED`, `NO_PHARMACY_MATCH`, `ADDRESS_OUTSIDE_ETHIOPIA` (reused from Module 02).
- **POST `/checkout`** — `{ addressId, chosenPharmacyId?, deliverySlot?, idempotencyKey }` → `201 { orderId, orderNumber, status: 'PAID' }`. Errors: `RX_REQUIRED`, `NO_PHARMACY_MATCH`, `INSUFFICIENT_STOCK` (reused from Module 04), `ADDRESS_OUTSIDE_ETHIOPIA`, `PRICE_CHANGED` (new, §10), `IDEMPOTENCY_CONFLICT`.

### 9.3 Orders (customer, `order:read:own`)
- **GET `/orders`** → `200 { items[], total }`, paginated, filterable by `status?`.
- **GET `/orders/:id`** → `200` detail + `statusHistory[]`.
- **POST `/orders/:id/cancel`** — `{ reason }` → `200`. Errors: `CANCELLATION_NOT_ALLOWED` (new, §10).
- **GET `/orders/:id/invoice`** → `200` (JSON `totals`, no PDF, §0.2).

### 9.4 Pharmacy fulfillment (`order:fulfill:org`)
- **GET `/pharmacy/orders`** → `200`, scoped to the caller's org via `IIdentityPort.getUserOrganizationIds()`.
- **POST `/pharmacy/orders/:fulfillmentId/accept`** → `200`.
- **POST `/pharmacy/orders/:fulfillmentId/decline`** — `{ reason }` → `200`, triggers re-match (§13.1). Errors: `NO_PHARMACY_MATCH`/`MATCH_FAILED` (reused from Module 05) if re-match exhausts candidates → order `CANCELLED`.
- **POST `/pharmacy/orders/:fulfillmentId/prepare`** → `200` (dispenses Rx lines via `IDispensingPort`).
- **POST `/pharmacy/orders/:fulfillmentId/ready`** → `200` (dispatches stock via `IInventoryPort.dispatch()`; cascades `Order.status → READY`).

**Not built in Slice 1:** `/orders/:id/substitution/respond` (§0.2), `/pharmacy/orders/:fulfillmentId/substitute` (§0.2), all `/admin/orders/*` routes (§0.2).

---

## 10. Error Codes

Reused, **not** redefined: `VALIDATION_ERROR`, `NOT_FOUND`, `CONFLICT`, `RBAC_FORBIDDEN`, `IDEMPOTENCY_CONFLICT`, `ADDRESS_OUTSIDE_ETHIOPIA` (Module 02), `RX_REQUIRED`/`NO_PHARMACY_MATCH`/`MATCH_FAILED` (Module 05), `INSUFFICIENT_STOCK` (Module 04) — confirmed present in `shared/errors/error-codes.ts` today; no cross-module code is redefined, same discipline Module 05 §15.2 required of itself.

**New codes required (to be appended to `shared/errors/error-codes.ts` as part of Module 06's own implementation PR, not before it — same Phase-0 freeze-exception pattern every prior module used):**
| New `ErrorCode` member | HTTP status | Used by |
| --- | --- | --- |
| `PRICE_CHANGED` | 409 | `/checkout` — cart price diverged from the fresh Module 03 read at step 1; client must re-quote |
| `INVALID_ORDER_STATE_TRANSITION` | 409 | `OrderStateMachine` guard violations (concurrent accept/decline race, double-cancel, etc.) — one code per aggregate, same convention as Module 05's `INVALID_PRESCRIPTION_STATE_TRANSITION`/`INVALID_MATCH_STATE_TRANSITION` |
| `CANCELLATION_NOT_ALLOWED` | 422 | `CancelOrderCommand` on an order past `READY` |
| `ORDER_NOT_FOUND` | 404 | order-scoped reads/mutations — mirrors `PRESCRIPTION_NOT_FOUND`'s per-aggregate convention rather than reusing the generic `NOT_FOUND` for a resource this central |

`PAYMENT_FAILED` (named in the parent doc's own error list) is **not added in Slice 1** — there is no payment path that can produce it yet; adding it now would repeat the exact "dead code for an unbuilt feature" mistake Module 05 §15.2 explicitly avoided for `BENEFICIARY_ACCESS_DENIED`.

---

## 11. Transactions & Concurrency

Every mutating command that co-locates a state change with an `AuditService.record(..., tx)` call and an outbox write **must** run at `Prisma.TransactionIsolationLevel.Serializable` with a bounded retry wrapper — Module 06's own copy, `runWithOrderRetry`/`isRetryableTransactionConflict` (own file, ADR-002, not a cross-module import of Module 05's `match-retry.ts`), per ADR-013. This applies to: `AddToCartCommand` (arguably read-mostly, but the cart-item unique-constraint upsert still benefits from the same discipline), `CheckoutCommand`, `AcceptFulfillmentCommand`, `DeclineFulfillmentCommand`, `PrepareFulfillmentCommand`, `MarkReadyCommand`, `CancelOrderCommand`.

**Cart concurrency** — `CartItem`'s existing `@@unique([cartId, catalogProductId])` constraint is the actual concurrency-safety mechanism for "add the same item twice" races (an upsert, not an insert-then-check) — no `Serializable` isolation is required for cart mutations alone (low stakes, no audit-chain co-location needed for a pre-order cart edit); reserve `Serializable` for the checkout/fulfillment commands where money/stock/audit genuinely co-locate.

**Checkout concurrency** — the idempotency key (§4) is the primary defense against duplicate orders on retry; `Order.idempotencyKey`'s `@unique` constraint is the DB-enforced backstop, mirroring Module 05's `DispenseRecord` idempotency design (§6.3 of that spec) exactly — a unique-constraint hit on retry is a **replay**, not an error, resolved by re-reading the already-committed `Order` and returning it.

**Inventory reservation races** — not Module 06's concern to re-solve; Module 04's `IInventoryPort.reserve()` already handles this at `Read Committed` + `FOR UPDATE` (its own spec's §8), and Module 06 calls it exactly as Module 05 does — no new race-handling logic needed here.

**Cancellation races** (concurrent cancel + accept) — resolved by `OrderStateMachine.assertValidTransition()` re-checked inside the `Serializable` transaction on a fresh, in-transaction read (never a pre-transaction read) — identical discipline to Module 05's `ApprovePrescriptionCommand`/`RejectPrescriptionCommand` race handling (§16 edge case 2 of that spec), one side wins, the other gets a deterministic `409 INVALID_ORDER_STATE_TRANSITION` or, under genuine write-conflict, a retried-then-resolved outcome — never a raw `500`.

**Order state transition races** (concurrent accept/decline on the same fulfillment) — same mechanism as above, applied to `Fulfillment.status`.

---

## 12. Testing Requirements (Slice 1, "required not optional" per Module 05 §18.3's precedent)

### 12.1 Unit (domain, no DB)
`OrderStateMachine` (every legal/illegal transition pair, incl. the reduced reachable set from §3.4); `CancellationPolicyService`; `PricingCalculator` (fixed fixtures, no DB); `runWithOrderRetry`/`isRetryableTransactionConflict` (own copy, same P2034/40001/40P01 recognition + 5-attempt exhaustion contract as Module 05's `match-retry.spec.ts`).

### 12.2 Application (ports mocked)
Each command — happy path + every documented error, asserting correct outbox events queued via a mocked `OutboxService`, same style as Module 05's own command specs. `CheckoutCommand`'s suite explicitly includes an idempotency-replay case (same `idempotencyKey` twice) asserting no second `Order` row and no second `OrderPlaced` outbox write.

### 12.3 Integration/E2E (`test/orders/*.e2e-spec.ts`, real Postgres via Testcontainers, same harness as `test/prescription-matching/*`)
| File | Scenarios |
| --- | --- |
| `cart-management.e2e-spec.ts` | Add/update/remove/clear; duplicate-item upsert; `/cart/validate` flags a stale price and an out-of-stock item |
| `checkout-workflow.e2e-spec.ts` | Happy path (real Module 03/04/05 integration, not mocked — same "real cross-module call" discipline as Module 05's own `infrastructure-adapters.e2e-spec.ts`) producing a real reservation + `Order`/`OrderLine`/`Fulfillment`/`Invoice`/`OrderStatusHistory` row; `RX_REQUIRED` block; `NO_PHARMACY_MATCH`; idempotency replay returns the same order |
| `fulfillment-workflow.e2e-spec.ts` | Accept → prepare (real `IDispensingPort.dispense()` call, decrementing a real `PrescriptionLine.remainingDispensable`) → ready (real `IInventoryPort.dispatch()` call); decline → re-match (real Module 05 `RematchCommand`) → re-accept; decline exhausting all candidates → order `CANCELLED` |
| `cancellation.e2e-spec.ts` | Cancel before `READY` releases the real Module 04 reservation; cancel attempt at/after `READY` → `422 CANCELLATION_NOT_ALLOWED` |
| `access-control.e2e-spec.ts` | Cross-customer order isolation; cross-pharmacy fulfillment isolation; unauthenticated → `401`; missing-permission role → `403` (same stripped-`CUSTOMER`-role test pattern established across Module 05's HTTP suite) |
| `atomicity.e2e-spec.ts` | **Required** — poisoned-outbox pattern (mirrors Module 05's `application-workflow.e2e-spec.ts`) for `CheckoutCommand`, `AcceptFulfillmentCommand`, `PrepareFulfillmentCommand`, `CancelOrderCommand`: no partial `Order`/`OrderLine`/`Fulfillment`/audit/outbox row survives a mid-transaction failure |
| `concurrency.e2e-spec.ts` | Concurrent accept/decline race on the same fulfillment (§11) — exactly one wins; concurrent checkout with the same idempotency key — exactly one `Order` row |
| `event-contracts.e2e-spec.ts` | Every event in §8 fires with the exact contracted payload, mirroring Module 05's own `event-contracts.e2e-spec.ts` pattern |

### 12.4 Regression requirement
Modules 01–05's existing suites (91 unit / 551 tests, 38 e2e / 277 tests as of `9c0191d`) must remain green throughout. Module 06 adds a new module folder and appends to two shared files (`error-codes.ts` §10, `rbac-catalog.ts` — though §7.1 found **no new permissions are actually needed**, so this file may end up untouched) but must not edit any existing Module 01–05 source file's behavior, **except** the one, explicitly-flagged §13.1 change to `prescription-matching.module.ts`'s `exports` array.

---

## 13. Decision Gates — require review before implementation

### 13.1 Module 05 matching-port exposure — **decision required**
**Finding:** `FindMatchCommand`, `SelectMatchCommand`, `RematchCommand`, `GetMatchResultQuery` are registered providers in `prescription-matching.module.ts` but not exported. Module 06's `CheckoutCommand` (step 3) and `DeclineFulfillmentCommand` (re-match) both need this capability.

**Two options, per ADR-002's "own copy" discipline vs. Module 04's `IInventoryPort` direct-export precedent:**
- **Option A — export the commands directly**, adding them to `prescription-matching.module.ts`'s `exports` array (no new file, minimal diff) — mirrors how `IInventoryPort` itself is a concrete injectable, not wrapped in a second interface, because "re-wrapping an already-clean port in another port adds a layer with no behavioral difference" (Module 05 §2.1's own words, applied to itself here).
- **Option B — introduce a dedicated inbound `IMatchingPort`** (new file, `application/ports/inbound/matching.port.ts`) wrapping `find`/`select`/`rematch`/`getResult`, mirroring `ICheckRxGatePort`/`IDispensingPort`'s existing inbound-port pattern — more consistent with those two siblings, at the cost of one more file and a thin pass-through implementation.

**Recommendation (non-binding, for review):** Option B, for consistency with the two inbound ports Module 05 already exports this exact way — but this is explicitly **not decided by this document**. **This is a small, additive Module 05 change** (new export or new port file; no existing behavior changes, no schema change) that must land as its own reviewed, tested commit **before** `CheckoutCommand`/`DeclineFulfillmentCommand` can be implemented. It is the first concrete Module-05-adjacent task in §14.

### 13.2 COD-only vs. future Payment integration — **decided**
Slice 1 is COD-only (§0.1, §4). `IPaymentPort` is documented (§5) but not built. This is not left open — it is the resolution.

### 13.3 Delivery lifecycle boundary — **decided**
Order lifecycle reaches `READY` and stops (§3.4). `DISPATCHED`/`DELIVERED`/`COMPLETED` are schema-present, Slice-1-unreachable. Not left open.

### 13.4 Beneficiary handling — **decided**
Opaque, unenforced `beneficiaryId`, `beneficiarySnapshot: null` (§3.3, §0.2) — identical resolution to Module 05 §2.2, applied here for consistency across the two modules that share this same upstream gap.

### 13.5 Idempotency mechanism — **decided**
DTO-body `idempotencyKey` field, not an HTTP header + interceptor. **Finding:** no `IdempotencyInterceptor`/header-based idempotency exists anywhere in the codebase today — both Module 04 (`ReserveStockDto.idempotencyKey`) and Module 05 (`DispenseMedicineInput.idempotencyKey`) use a body field. The parent doc's §6/§8.2 "+ `Idempotency-Key` header" phrasing has no precedent in this codebase and would introduce a new cross-cutting interceptor pattern with a sample size of one consumer — **not adopted**, in favor of the already-proven, twice-precedented body-field convention.

### 13.6 Split fulfillment dependency — **decided**
Deferred until Module 05 itself supports split matching (§0.2) — Module 06 cannot build ahead of a capability its own matching dependency doesn't yet expose.

---

## 14. Implementation Order

1. **Module 05 export change (§13.1)** — land and test the matching-port exposure decision as its own small commit, *before* any Module 06 code exists that depends on it. This is a prerequisite gate, not a Module 06 task.
2. **Schema verification** — confirm `06-orders.prisma` migrates cleanly against the current baseline (no changes expected per §6, but verify, don't assume).
3. **Domain** — enums, VOs (§3.10), `OrderStateMachine`/`CancellationPolicyService`/`PricingCalculator` (§3.11), unit-tested in isolation first.
4. **Repositories** — `ICartRepository`/`IOrderRepository`/`IFulfillmentRepository` contracts, then Prisma implementations.
5. **Own-copy ports** — `ICatalogPort`, `IIdentityPort`, `IAddressPort` (§5), each with a repository-level e2e test mirroring Module 05's `infrastructure-adapters.e2e-spec.ts` pattern.
6. **`PrismaUnitOfWork` + `runWithOrderRetry`** — own copies, unit-tested against the exact same retry-exhaustion contract Module 05's `match-retry.spec.ts` already established.
7. **Application commands/queries** — cart commands first (simplest, lowest risk), then `CheckoutCommand` (the saga, §4), then fulfillment commands, then `CancelOrderCommand`.
8. **Cross-module wiring** — `imports: [PharmacyInventoryModule, PrescriptionMatchingModule]` in `orders.module.ts`, direct injection of `INVENTORY_PORT`/`CHECK_RX_GATE_PORT`/`DISPENSING_PORT`/the §13.1 matching contract.
9. **HTTP layer** — controllers/DTOs/guards (§9), thin adapters over the commands above, no business logic in controllers (same discipline as Module 05's `PrescriptionController`/`VerificationController`/`MatchingController`).
10. **Event contracts + atomicity + concurrency e2e** (§12.3) — the same rigor Module 05 §18.3 required, proven this session to be genuinely load-bearing (it caught real coverage gaps during Module 05's own final audits).
11. **Full regression run** (§12.4) — `npm run test` + `npm run test:e2e` against the full monolith, not just the new module's suites, before considering Module 06 Slice 1 mergeable.

---

## Final Sign-Off Checklist (for the reviewer, before implementation begins)

- [ ] §13.1's Module 05 export decision made (Option A or B) and scheduled as a prerequisite commit.
- [ ] §7.1's "no new RBAC permissions needed" finding independently verified against `rbac-catalog.ts` at implementation time (in case it drifts before then).
- [ ] §10's four new error codes reviewed and agreed before the implementation PR appends them.
- [ ] §3.4's schema-vs-parent-doc reconciliation reviewed and accepted (no Prisma migration proposed).
- [ ] §0.2's deferral list reviewed and accepted as the Slice-1/Slice-2 boundary.
