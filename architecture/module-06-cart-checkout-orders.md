# Module 6 — Cart, Checkout & Orders (Design Document)

**Product:** PharmaLink Ethiopia — Digital Healthcare Marketplace
**Module:** 06 — Cart, Checkout & Orders (Cart, checkout orchestration, order lifecycle/state machine, fulfillment)
**Status:** Design — Approved for implementation reference
**Architecture style:** Modular Monolith (NestJS) · Clean Architecture · DDD · SOLID
**Depends on:** Module 01 (Identity), 02 (Beneficiary/Address), 03 (Catalog), 04 (Inventory/reservation), 05 (Rx gate/matching). Consumed by: Payment (07), Delivery (09), Notification, Reviews.
**Traceability:** FR-ORD-01..12, FR-MED-10, FR-PAY-03, FR-NOT-02, BRULE-17, BRULE-18, BRULE-19, BRULE-20, BRULE-21, NFR-PERF, NFR-AVAIL-02, NFR-AUDIT

> Single source of truth for the Cart, Checkout & Orders bounded context. No implementation code — contracts, schemas, flows, and reasoning only.

---

## 1. Module Objectives

This module is the **transactional heart** of the marketplace — it turns intent (a cart) into a governed, trackable **order** and orchestrates the cross-module workflow: **Rx gate → matching → stock reservation → payment authorization → fulfillment → delivery handoff**.

**Orchestrator role.** Cart/Order does **not** own stock, prescriptions, matching, or payments — those live in Modules 3–5 and 7. This module is the **process manager (saga orchestrator)** that sequences them and owns the **order aggregate and its lifecycle**. This keeps each domain authoritative in its own module while one place governs the end-to-end transaction and its compensations (e.g., release stock + refund if a later step fails).

**Primary objectives**
- Manage the **cart**: add/update/remove items, live totals (FR-ORD-01/02).
- Orchestrate **checkout**: validate Rx gate (FR-MED-10), run matching (FR-MATCH), reserve stock (Module 4), authorize payment (FR-PAY-03, BRULE-17), then place the order.
- Own the **order lifecycle state machine** (placed→verified→accepted→dispatched→delivered→completed/cancelled) (FR-ORD-05).
- Support **beneficiary + delivery address** selection, incl. diaspora orders (FR-ORD-03, BRULE-21).
- Enable **pharmacy fulfillment** actions (accept, prepare, mark ready) (FR-ORD-09) and **customer cancellation** within rules (FR-ORD-07, BRULE-20).
- Generate **itemized receipts/invoices** (FR-ORD-10) and support scheduled delivery, partial fulfillment/substitution (FR-ORD-11/12).
- Notify all parties at each status change (FR-ORD-08, FR-NOT-02).

---

## 2. Business Requirements

| ID | Business Requirement | Source |
| --- | --- | --- |
| BR-ORD-01 | Customers can add/update/remove cart items. | FR-ORD-01 |
| BR-ORD-02 | Totals include item price, delivery, and fees. | FR-ORD-02 |
| BR-ORD-03 | Checkout selects a delivery address and beneficiary. | FR-ORD-03 |
| BR-ORD-04 | Rx items cannot be checked out without a valid prescription. | FR-MED-10, BRULE-10 |
| BR-ORD-05 | An order is confirmed only after successful payment authorization (except COD where enabled). | FR-ORD-04, FR-PAY-03, BRULE-17 |
| BR-ORD-06 | Orders maintain a status lifecycle. | FR-ORD-05 |
| BR-ORD-07 | Customers can view order status and history. | FR-ORD-06 |
| BR-ORD-08 | Orders can be cancelled within permitted rules (before dispatch). | FR-ORD-07, BRULE-20 |
| BR-ORD-09 | Pharmacy and customer are notified at each status change. | FR-ORD-08, FR-NOT-02 |
| BR-ORD-10 | Pharmacies can accept, prepare, and mark orders ready. | FR-ORD-09 |
| BR-ORD-11 | An itemized digital receipt/invoice is generated. | FR-ORD-10 |
| BR-ORD-12 | Scheduled/future delivery time can be selected. | FR-ORD-11 |
| BR-ORD-13 | Partial fulfillment and out-of-stock substitution handled with customer consent. | FR-ORD-12, BRULE-16 |
| BR-ORD-14 | If a matched pharmacy declines/unavailable, the order is re-matched. | FR-MATCH-06, BRULE-19 |
| BR-ORD-15 | Diaspora orders specify a valid beneficiary + Ethiopian delivery address. | BRULE-21 |

---

## 3. Functional Requirements (Module Features)

### 3.1 Cart
- **F-CRT-01** Add item (catalog product + qty) to cart; one active cart per customer (optionally per beneficiary).
- **F-CRT-02** Update quantity / remove item / clear cart.
- **F-CRT-03** Live pricing: item subtotal via candidate pharmacy price (indicative) + estimated delivery + platform fee (FR-ORD-02).
- **F-CRT-04** Rx flagging in cart: mark items needing a prescription; block checkout until satisfied (FR-MED-10).
- **F-CRT-05** Persist cart across sessions/devices; merge on login.
- **F-CRT-06** Validate cart at checkout (prices/stock refreshed; stale prices reconciled).

### 3.2 Checkout Orchestration
- **F-CHK-01** Select beneficiary (Module 2) + delivery address (ET geofence, BRULE-21).
- **F-CHK-02** Run **Rx gate** (Module 5) — block/allow Rx lines (FR-MED-10).
- **F-CHK-03** Run **matching** (Module 5) → choose pharmacy(ies); allow customer override (FR-MATCH-04).
- **F-CHK-04** Compute final totals (item + delivery by zone/distance + fees + coupons/wallet from Module 7).
- **F-CHK-05** **Reserve stock** (Module 4) for chosen listings.
- **F-CHK-06** **Authorize payment** (Module 7) — order confirmed only on success (BRULE-17); COD path where enabled (FR-PAY-08).
- **F-CHK-07** Create the **Order** with immutable **snapshots** (beneficiary, address, prices, pharmacy) — see §5.
- **F-CHK-08** Scheduled delivery slot selection (FR-ORD-11).
- **F-CHK-09** Idempotent checkout (idempotency key) to prevent duplicate orders on retry.

### 3.3 Order Lifecycle & Fulfillment
- **F-ORD-01** State machine transitions with guards (see §4).
- **F-ORD-02** Pharmacy: accept / decline / prepare / mark ready (FR-ORD-09).
- **F-ORD-03** Decline/timeout → **re-match** remaining lines (BRULE-19) or cancel+refund.
- **F-ORD-04** Handoff to Delivery when ready (create delivery job — Module 9).
- **F-ORD-05** Delivery status sync → order (dispatched, en route, delivered).
- **F-ORD-06** Completion (post-delivery confirmation) → enables review (Module 13).
- **F-ORD-07** Cancellation (customer/pharmacy/system) with policy + compensation (release stock, refund).
- **F-ORD-08** Partial fulfillment / substitution with customer consent (FR-ORD-12, BRULE-16).
- **F-ORD-09** Order history + detail views for all parties (FR-ORD-06).
- **F-ORD-10** Itemized receipt/invoice generation (FR-ORD-10).

---

## 4. Order State Machine (FR-ORD-05)

**States:** `DRAFT → PENDING_PAYMENT → PAID → PENDING_VERIFICATION → ACCEPTED → PREPARING → READY_FOR_PICKUP → DISPATCHED → OUT_FOR_DELIVERY → DELIVERED → COMPLETED`; terminal branches: `CANCELLED`, `REFUNDED`, `PARTIALLY_FULFILLED`, `FAILED`.

**Key transitions & guards**
| From | Event | To | Guard |
| --- | --- | --- | --- |
| DRAFT | checkout submitted | PENDING_PAYMENT | Rx gate passed, stock reserved, address valid (BRULE-21) |
| PENDING_PAYMENT | payment authorized | PAID | payment success (BRULE-17); COD → skip to PENDING_VERIFICATION |
| PENDING_PAYMENT | payment failed/timeout | CANCELLED | release reservations |
| PAID | needs Rx verify | PENDING_VERIFICATION | has Rx items (Model A: chosen pharmacy verifies, Module 5) |
| PAID / PENDING_VERIFICATION | pharmacy accepts | ACCEPTED | pharmacy eligible; Rx approved (if any) |
| PENDING_VERIFICATION | Rx rejected | PARTIALLY_FULFILLED / CANCELLED | refund Rx portion; re-match remainder |
| ACCEPTED | begins prep | PREPARING | — |
| PREPARING | marks ready | READY_FOR_PICKUP | stock dispensed (Module 4/5 ledgers) |
| READY_FOR_PICKUP | delivery job created & picked | DISPATCHED | delivery assigned (Module 9) |
| DISPATCHED | rider en route | OUT_FOR_DELIVERY | — |
| OUT_FOR_DELIVERY | delivered (+ PoD) | DELIVERED | proof of delivery where required (BRULE-29) |
| DELIVERED | confirmation window elapses / customer confirms | COMPLETED | enables review |
| ACCEPTED/PENDING_* | pharmacy declines / timeout | (re-match) or CANCELLED | BRULE-19 |
| any pre-DISPATCHED | customer cancels | CANCELLED | within cancellation policy (BRULE-20) → refund + release |

**Design rationale — explicit state machine.** Orders coordinate many modules and money; an explicit, guarded state machine (each transition validated, logged, and event-emitting) prevents illegal transitions, makes the workflow auditable, and gives every consumer (delivery, notifications, analytics) a single reliable status source. Transitions are the **only** way state changes — no ad-hoc mutation.

---

## 5. Domain Model

### 5.1 Aggregates & Entities
- **Cart** (aggregate root) — transient pre-order basket with items.
- **CartItem** (entity) — catalog product + qty + indicative price.
- **Order** (aggregate root) — the confirmed transaction; owns lifecycle, totals, snapshots, and lines.
- **OrderLine** (entity) — product snapshot + qty + fulfilling pharmacy/branch + Rx link + line status (for partial/split).
- **OrderStatusHistory** (immutable) — every transition (from→to, actor, reason, time).
- **Fulfillment** (entity) — per-pharmacy grouping when an order is split (FR-MATCH-07) → maps to one delivery job.

### 5.2 Value Objects
- `Money` (ETB minor units), `OrderStatus`, `LineStatus` (PENDING|ACCEPTED|SUBSTITUTED|FULFILLED|CANCELLED|REFUNDED), `AddressSnapshot`, `BeneficiarySnapshot`, `PriceSnapshot`, `DeliverySlot`, `IdempotencyKey`, `CancellationPolicy`.

### 5.3 Invariants
- **Snapshots are immutable.** At order creation, the beneficiary, delivery address, unit prices, and pharmacy identity are **copied into the order** (per Module 2's snapshot rationale). Later edits/deletes to source data never alter historical orders.
- An order enters `PAID`/`ACCEPTED` **only** with successful payment authorization (BRULE-17) — except configured COD.
- No Rx line reaches `PREPARING`/dispense without an approved prescription (delegated to Module 5 gate + verification, BRULE-10).
- Cancellation allowed **only before `DISPATCHED`** and per `CancellationPolicy` (BRULE-20).
- Every state change appends to `OrderStatusHistory` and emits a domain event (no silent transitions).
- Order totals = Σ line prices + delivery + fees − discounts; recomputed and frozen at confirmation (customer never charged more than confirmed).

---

## 6. Checkout Saga (Orchestration & Compensation)

Checkout is a **saga** (orchestrated) because it spans modules and money. Each step has a compensating action on failure:

| Step | Action | Compensation on later failure |
| --- | --- | --- |
| 1 | **Validate cart** (refresh prices/stock) | — |
| 2 | **Rx gate** (Module 5) | abort if blocked → `RX_REQUIRED` |
| 3 | **Match** (Module 5) → choose pharmacy(ies) | — |
| 4 | **Reserve stock** (Module 4) | **release reservations** |
| 5 | **Compute totals** (+ coupons/wallet, Module 7) | — |
| 6 | **Create Order** `PENDING_PAYMENT` (snapshots) | mark `CANCELLED` |
| 7 | **Authorize payment** (Module 7) | on fail → release stock + cancel order |
| 8 | **Confirm** → `PAID`; confirm reservations; notify | on any post-payment failure → refund + release |

**Idempotency.** The client sends an `Idempotency-Key`; replays return the same order rather than creating duplicates (critical on flaky mobile networks — NFR-LOC-04).

**Reliability.** Uses the **Outbox pattern** — domain events (OrderPlaced, PaymentRequested, StockReserved) are written in the same DB transaction as state changes and published reliably, so a crash mid-saga leaves a recoverable, consistent state (NFR-AVAIL). A saga coordinator resumes/compensates incomplete orders.

**Design rationale — orchestration over choreography.** For a money+stock+prescription workflow with strict ordering and compensation, an **orchestrated saga** (one coordinator) is clearer, easier to audit, and easier to reason about failures than event choreography spread across modules. It matches the "one place governs the transaction" objective.

---

## 7. Database Design (PostgreSQL via Prisma)

UUID v7 PKs; timestamps; Money as integer minor units + currency (ETB).

**carts**
- `id`, `customer_user_id` (FK), `beneficiary_id` (nullable), `status` (ACTIVE|CONVERTED|ABANDONED), `updated_at`, `created_at`.

**cart_items**
- `id`, `cart_id` (FK), `catalog_product_id` (FK), `quantity`, `indicative_price`, `requires_rx` (cached from catalog), `added_at`.
- Unique (`cart_id`,`catalog_product_id`).

**orders** — aggregate root.
- `id`, `order_number` (human-readable, unique), `customer_user_id` (FK), `beneficiary_snapshot` (jsonb), `address_snapshot` (jsonb), `status`, `strategy` (SINGLE|SPLIT), `subtotal`, `delivery_fee`, `platform_fee`, `discount_total`, `grand_total`, `currency`, `payment_id` (ref → Module 7, nullable), `match_request_id` (ref → Module 5), `delivery_slot` (nullable), `idempotency_key` (unique), `is_cod` (bool), `placed_at`, `completed_at`, `cancelled_at`, `cancel_reason`, `created_at`, `updated_at`.

**order_lines**
- `id`, `order_id` (FK), `catalog_product_id` (FK), `product_snapshot` (jsonb: name/strength/form), `quantity`, `unit_price` (snapshot), `line_total`, `fulfillment_id` (FK → fulfillments, nullable), `pharmacy_id`, `branch_id`, `reservation_id` (ref → Module 4), `prescription_line_id` (ref → Module 5, nullable), `requires_rx`, `line_status`, `substituted_from_product_id` (nullable), `created_at`.

**fulfillments** — per-pharmacy grouping (split orders).
- `id`, `order_id` (FK), `pharmacy_id`, `branch_id`, `status`, `delivery_job_id` (ref → Module 9, nullable), `accepted_at`, `ready_at`, `created_at`.

**order_status_history** — immutable transition log.
- `id`, `order_id` (FK), `from_status`, `to_status`, `event`, `actor_user_id` (nullable), `actor_role`, `reason`, `created_at`. Append-only.

**invoices** — itemized receipts (FR-ORD-10).
- `id`, `order_id` (FK), `invoice_number` (unique), `pdf_ref` (storage), `totals` (jsonb), `issued_at`.

**outbox** — reliable event publishing.
- `id`, `aggregate_type`, `aggregate_id`, `event_type`, `payload` (jsonb), `published_at` (nullable), `created_at`.

**Relationships**
- `carts 1—N cart_items`.
- `orders 1—N order_lines / fulfillments / order_status_history`; `orders 1—1 invoices`.
- `fulfillments 1—N order_lines`.
- References (by ID) to payment (7), reservation & pharmacy (4), prescription line & match request (5), delivery job (9).

**Rationale.** Heavy use of **snapshots (jsonb)** on orders/lines guarantees historical accuracy and dispute-readiness independent of later changes in Modules 2/3/4. The `outbox` table makes cross-module effects reliable under crashes (exactly-once-ish delivery via publisher + idempotent consumers).

---

## 8. API Design

Base paths: `/api/v1/cart`, `/api/v1/checkout`, `/api/v1/orders`, `/api/v1/pharmacy/orders` (fulfillment), `/api/v1/admin/orders`. Bearer auth; ownership/RBAC enforced. Envelope/errors per Module 1 §14.

### 8.1 Cart (customer)
- **GET `/cart`** — current active cart with live totals.
- **POST `/cart/items`** — `{ catalogProductId, quantity, beneficiaryId? }`. → cart.
- **PATCH `/cart/items/{id}`** — update qty. **DELETE `/cart/items/{id}`**. **DELETE `/cart`** — clear.
- **POST `/cart/validate`** — refresh prices/stock, flag Rx items → readiness report.

### 8.2 Checkout (customer)
- **POST `/checkout/quote`** — `{ beneficiaryId, addressId, deliverySlot? }` → Rx gate result + match candidates + full price breakdown (no order yet).
- **POST `/checkout`** — `{ beneficiaryId, addressId, chosenPharmacyId?, paymentMethod, couponCode?, useWallet?, deliverySlot?, isCod? }` + `Idempotency-Key` header → runs saga → `{ orderId, orderNumber, status, paymentIntent? }`.
  - Errors: `RX_REQUIRED`, `NO_PHARMACY_MATCH`, `INSUFFICIENT_STOCK`, `ADDRESS_OUTSIDE_ETHIOPIA`, `PAYMENT_FAILED`, `PRICE_CHANGED` (re-quote required).

### 8.3 Orders (customer)
- **GET `/orders`** — history (paginated, filter by status). **GET `/orders/{id}`** — detail + status timeline + tracking ref.
- **POST `/orders/{id}/cancel`** — `{ reason }` → policy-checked (BRULE-20) → refund + release. Errors: `CANCELLATION_NOT_ALLOWED`.
- **POST `/orders/{id}/substitution/respond`** — `{ lineId, accept }` — consent to substitution (FR-ORD-12).
- **GET `/orders/{id}/invoice`** — download receipt.

### 8.4 Pharmacy fulfillment (`order:fulfill:org`)
- **GET `/pharmacy/orders`** — incoming/active orders (scoped to pharmacy).
- **POST `/pharmacy/orders/{fulfillmentId}/accept`** — accept (guards eligibility + Rx approved).
- **POST `/pharmacy/orders/{fulfillmentId}/decline`** — `{ reason }` → triggers re-match (BRULE-19).
- **POST `/pharmacy/orders/{fulfillmentId}/prepare`** / **`/ready`** — prep → ready (dispenses stock, Modules 4/5).
- **POST `/pharmacy/orders/{fulfillmentId}/substitute`** — propose substitute (awaits customer consent, BRULE-16).

### 8.5 Admin
- **GET `/admin/orders`** — search/monitor. **POST `/admin/orders/{id}/force-cancel`** — dispute resolution (audited).

---

## 9. NestJS Folder Structure (Clean Architecture)

```
src/modules/orders/
  domain/
    entities/            # Cart, CartItem, Order, OrderLine, Fulfillment, OrderStatusHistory, Invoice
    value-objects/       # Money, OrderStatus, LineStatus, AddressSnapshot, BeneficiarySnapshot,
    │                    # PriceSnapshot, DeliverySlot, CancellationPolicy, IdempotencyKey
    events/              # OrderPlaced, OrderPaid, OrderAccepted, OrderReady, OrderDispatched,
    │                    # OrderDelivered, OrderCompleted, OrderCancelled, RematchRequested, SubstitutionProposed
    enums/               # OrderStatus, LineStatus, FulfillmentStatus, CartStatus
    repositories/        # ICartRepository, IOrderRepository, IFulfillmentRepository, IOutboxRepository
    services/            # OrderStateMachine, PricingCalculator, CancellationPolicyService
  application/
    sagas/               # CheckoutSaga (orchestrator + compensations)
    commands/            # AddToCart, UpdateCart, Checkout, CancelOrder, AcceptFulfillment,
    │                    # DeclineFulfillment, MarkReady, RespondSubstitution, AdvanceOrderStatus
    queries/             # GetCart, QuoteCheckout, GetOrder, ListOrders, GetPharmacyOrders, GetInvoice
    ports/               # IRxGatePort(5), IMatchingPort(5), IInventoryPort(4), IPaymentPort(7),
    │                    # IWalletCouponPort(7), IDeliveryPort(9), IBeneficiaryPort(2), ICatalogPort(3),
    │                    # INotificationPort, IInvoicePort, IAuditPort, ICachePort
    dtos/  mappers/
  infrastructure/
    persistence/prisma/  repositories/       # Prisma*; transactional order+outbox writes
    outbox/              # OutboxPublisher (relays events reliably)
    saga/                # SagaCoordinator (resume/compensate incomplete orders)
    invoice/             # PdfInvoiceAdapter
    ports-adapters/      # RxGate/Matching/Inventory/Payment/Delivery/Wallet adapters
    scheduling/          # AcceptTimeoutSweeper, DeliveryConfirmSweeper, CartAbandonmentSweeper
    audit/ cache/
  interface/
    http/
      controllers/       # CartController, CheckoutController, OrderController, PharmacyOrderController, AdminOrderController
      dtos/ guards/ decorators/ filters/ interceptors/  # IdempotencyInterceptor, AuditInterceptor
    events/              # handlers: on PaymentSucceeded→confirm; on DeliveryDelivered→DELIVERED; on RxRejected→partial/cancel
  orders.module.ts
```

**Rationale.** The `CheckoutSaga` and `OrderStateMachine` are the module's core; every external effect goes through a port (Modules 4/5/7/9), so Orders orchestrates without embedding other domains' logic. The outbox + saga coordinator deliver reliability the healthcare/payment context demands.

---

## 10. Sequence Flows

### 10.1 Checkout (happy path, saga)
```
Client → POST /checkout {beneficiary,address,method} + Idempotency-Key
CheckoutSaga → IdempotencyInterceptor: replay? return existing order
CheckoutSaga → validate cart (refresh price/stock)  [PRICE_CHANGED → re-quote]
CheckoutSaga → IRxGatePort.check (Module 5)          [RX_REQUIRED]
CheckoutSaga → IMatchingPort.find+select (Module 5)  [NO_PHARMACY_MATCH]
CheckoutSaga → IInventoryPort.reserve (Module 4)     [INSUFFICIENT_STOCK]
CheckoutSaga → IWalletCouponPort.apply + PricingCalculator → totals
CheckoutSaga → IOrderRepository.create(PENDING_PAYMENT) + outbox(OrderPlaced)  [one TX]
CheckoutSaga → IPaymentPort.authorize (Module 7)
  success → OrderStateMachine: PENDING_PAYMENT→PAID; confirm reservations; outbox(OrderPaid)
          → INotificationPort: notify customer+pharmacy (FR-NOT-02)
  fail    → compensate: release reservations + refund wallet/coupon; status CANCELLED
→ {orderId, status}
```

### 10.2 Pharmacy Fulfillment
```
Pharmacy → POST /pharmacy/orders/{ff}/accept
AcceptFulfillment → guard: eligible + Rx approved(if any) → status ACCEPTED
Pharmacy → /prepare → PREPARING
Pharmacy → /ready → dispense stock (Module 4 DISPATCH + Module 5 DispenseRecord) → READY_FOR_PICKUP
→ emit OrderReady → IDeliveryPort.createJob (Module 9)
```

### 10.3 Decline → Re-match (BRULE-19)
```
Pharmacy → POST /pharmacy/orders/{ff}/decline {reason}
DeclineFulfillment → release reservations for that fulfillment
DeclineFulfillment → IMatchingPort.rematch (exclude pharmacy)
  next found → new fulfillment, re-reserve, notify
  none       → cancel affected lines → refund portion → notify (partial/cancel)
```

### 10.4 Cancellation (BRULE-20)
```
Client → POST /orders/{id}/cancel {reason}
CancelOrder → CancellationPolicyService: status < DISPATCHED?  else CANCELLATION_NOT_ALLOWED
CancelOrder → IInventoryPort.release + IPaymentPort.refund (Module 7)
CancelOrder → OrderStateMachine → CANCELLED; history + outbox(OrderCancelled); notify
```

### 10.5 Delivery → Completion
```
Delivery(9) event → OrderDispatched → status DISPATCHED → OUT_FOR_DELIVERY
Delivery delivered (+PoD, BRULE-29) → DELIVERED
DeliveryConfirmSweeper (or customer confirm) → COMPLETED → emit OrderCompleted (enables review, settlement)
```

---

## 11. Error Handling

Reuses Module 1 §14. Checkout errors surface the failing saga step clearly: `RX_REQUIRED`, `NO_PHARMACY_MATCH`, `INSUFFICIENT_STOCK`, `ADDRESS_OUTSIDE_ETHIOPIA` (BRULE-21), `PRICE_CHANGED` (must re-quote), `PAYMENT_FAILED`, `CANCELLATION_NOT_ALLOWED` (BRULE-20), `ORDER_NOT_FOUND`, `INVALID_STATE_TRANSITION` (state machine guard), `IDEMPOTENT_REPLAY` (returns existing order), `RBAC_FORBIDDEN`. Money-affecting failures always trigger compensation before returning.

---

## 12. Logging & Auditing

Reuses hash-chained `audit_logs`; `order_status_history` is itself an immutable transition trail. **Must-log:**
- Order placed (with totals), payment authorized/failed, order confirmed.
- Every state transition (from→to, actor, reason).
- Fulfillment accept/decline (+reason), prepare/ready, dispense hooks.
- Re-match events, substitution proposals + customer consent.
- Cancellation (actor, reason, refund ref), force-cancel (admin).
- Invoice issued.

Operational logs capture checkout latency and saga step failures for reliability tuning (NFR-AVAIL).

---

## 13. Future Scalability & Evolution

- **Saga reliability at scale** — outbox + idempotent consumers + a durable coordinator; can move to a workflow engine (e.g., Temporal) later behind the same saga interface.
- **Read scaling** — order history/detail served from read replicas + a denormalized order read model (CQRS) fed by outbox events.
- **Order sharding** — partition `orders`/`order_lines`/`status_history` by time and/or customer at volume.
- **Split fulfillment maturity** — `fulfillments` model already supports multi-pharmacy orders + multiple delivery jobs (FR-MATCH-07) when enabled.
- **Scheduled/subscription orders** — recurring medicine refills can reuse checkout with a scheduler (future).
- **Extraction-ready** — Orders depends on Modules 2/3/4/5/7/9 only via ports and communicates via events; it can become a standalone Order/Checkout service (the natural first microservice given its central role).

---

## Open Questions for Product/Compliance
1. **Cancellation policy specifics** — fees/windows for cancellation before dispatch (BRULE-20); who bears cost if pharmacy already prepared?
2. **COD availability** — is cash-on-delivery enabled at launch, and for which zones/order types (FR-PAY-08)?
3. **Split fulfillment at launch** — enable multi-pharmacy orders now or single-pharmacy only (ties to Module 4/5 open questions)?
4. **Delivery fee model** — flat, zone-based, or distance-based (FR-DEL-09) — needed by `PricingCalculator`.
5. **Order completion trigger** — auto-complete N hours after delivery, or require explicit customer confirmation?

---

**End of Module 6 design.** Awaiting your approval to proceed. Recommended next module: **Payment & Wallet** — payment gateway integration (Telebirr/bank/card, cross-border), authorization/capture/refund, wallet, coupons, and provider settlement (FR-PAY, BRULE-17/22..26), which this checkout saga depends on.
