# Module 7 — Payment, Wallet & Settlement (Design Document)

**Product:** PharmaLink Ethiopia — Digital Healthcare Marketplace
**Module:** 07 — Payment, Wallet, Coupons & Settlement
**Status:** Design — Approved for implementation reference
**Architecture style:** Modular Monolith (NestJS) · Clean Architecture · DDD · SOLID
**Depends on:** Module 01 (Identity), 06 (Orders). Consumed by: Orders (checkout saga), Admin/Finance, Analytics.
**Traceability:** FR-PAY-01..11, FR-ORD-04, FR-PRV-08, BRULE-17, BRULE-22, BRULE-23, BRULE-24, BRULE-25, BRULE-26, NFR-SEC-04, NFR-LOC-01/02, NFR-AVAIL, NFR-AUDIT

> Single source of truth for the Payment, Wallet & Settlement bounded context. No implementation code — contracts, schemas, flows, and reasoning only. **Money-critical module: correctness, idempotency, and auditability are paramount.**

---

## 1. Module Objectives

This module handles **all money movement**: collecting payment from customers (local + cross-border), managing an internal **wallet** and **coupons**, issuing **refunds**, and **settling** pharmacies/providers net of platform fees.

**Core principle — the platform is a ledger.** Every monetary event is recorded in an **immutable double-entry ledger**. Balances (wallet, payable-to-provider, platform revenue) are **derived** from ledger entries, never stored as mutable counters. This is non-negotiable for financial correctness, reconciliation, and audit (BRULE-25, NFR-AUDIT).

**PCI boundary.** The platform **never stores or handles raw card data** (BRULE-26, NFR-SEC-04). All card handling is delegated to a PCI-DSS-compliant provider via tokenization/hosted fields. Our DB stores only provider references and tokens.

**Primary objectives**
- Process payments via **integrated local providers** (Telebirr, bank, card) and **cross-border** for diaspora (FR-PAY-01/02, NFR-LOC-02).
- **Authorize before order confirmation** (FR-PAY-03, BRULE-17); confirm/capture on fulfillment.
- Record every transaction with a **unique, immutable reference** (FR-PAY-04, BRULE-25).
- Support **full and partial refunds** (FR-PAY-05, BRULE-24).
- Reconcile via **provider webhooks/callbacks** (FR-PAY-10).
- Compute and **settle provider payouts net of platform fees** (FR-PAY-06, BRULE-23) + reports (FR-PAY-07).
- Provide **wallet** and **coupons/discounts**; optional **cash-on-delivery** (FR-PAY-08).
- **Detect/flag suspicious transactions** (FR-PAY-09).

---

## 2. Business Requirements

| ID | Business Requirement | Source |
| --- | --- | --- |
| BR-PAY-01 | Process payments via local providers (Telebirr, bank, card). | FR-PAY-01 |
| BR-PAY-02 | Support cross-border payment for diaspora customers. | FR-PAY-02, NFR-LOC-02 |
| BR-PAY-03 | Authorize payment before order confirmation. | FR-PAY-03, BRULE-17 |
| BR-PAY-04 | Record all transactions with unique references. | FR-PAY-04, BRULE-25 |
| BR-PAY-05 | Support full and partial refunds for eligible cases. | FR-PAY-05, BRULE-24 |
| BR-PAY-06 | Calculate and settle provider payouts net of platform fees. | FR-PAY-06, BRULE-23 |
| BR-PAY-07 | Provide payment/settlement reports to providers and admins. | FR-PAY-07, FR-PRV-08 |
| BR-PAY-08 | Support cash-on-delivery where enabled by policy. | FR-PAY-08 |
| BR-PAY-09 | Detect and flag suspicious/fraudulent transactions. | FR-PAY-09 |
| BR-PAY-10 | Reconcile payments with provider callbacks/webhooks. | FR-PAY-10 |
| BR-PAY-11 | Never store raw card data (PCI via provider). | FR-PAY-11, BRULE-26, NFR-SEC-04 |
| BR-PAY-12 | All amounts recorded in ETB; cross-border converted at applicable rate. | BRULE-22, NFR-LOC-01 |
| BR-PAY-13 | Platform fees deducted before provider settlement. | BRULE-23 |
| BR-PAY-14 | Provide a wallet for balances, refunds, and payments. | Vision (wallet feature) |
| BR-PAY-15 | Support coupons/discounts applied at checkout. | Vision (coupons feature) |

---

## 3. Functional Requirements (Module Features)

### 3.1 Payment Processing
- **F-PAY-01** Initiate payment for an order via a chosen method (Telebirr/bank/card/wallet/COD).
- **F-PAY-02** **Authorize** (hold) funds pre-confirmation; **capture** on fulfillment; **void** on cancel-before-capture (FR-PAY-03).
- **F-PAY-03** Cross-border payment with currency conversion to ETB at applied rate (BRULE-22, FR-PAY-02).
- **F-PAY-04** Handle provider **webhooks/callbacks** for async confirmation + reconciliation (FR-PAY-10).
- **F-PAY-05** Idempotent payment ops (retry-safe) with unique references (BRULE-25).
- **F-PAY-06** COD flow: mark order COD, collect on delivery, reconcile driver cash (FR-PAY-08).

### 3.2 Refunds
- **F-RFD-01** Full refund (cancel/failed delivery) and **partial** refund (partial fulfillment/dispute) (FR-PAY-05, BRULE-24).
- **F-RFD-02** Refund to original method or to **wallet** (configurable/faster).
- **F-RFD-03** Refund eligibility checks tied to order state (BRULE-24) + audited approval for manual refunds.

### 3.3 Wallet
- **F-WAL-01** Wallet per user; balance derived from ledger.
- **F-WAL-02** Top-up (via payment), spend (at checkout), receive refunds/credits.
- **F-WAL-03** Wallet transaction history; holds/reservations for in-flight spends.

### 3.4 Coupons & Discounts
- **F-CPN-01** Define coupons (percentage/fixed, min-spend, expiry, usage limits, scope: product/category/pharmacy).
- **F-CPN-02** Validate + apply coupon at checkout; enforce per-user/global usage limits.
- **F-CPN-03** Reverse coupon usage on order cancellation.

### 3.5 Settlement (provider payouts)
- **F-STL-01** Accrue provider **payable** on order completion = order revenue − platform fee (BRULE-23).
- **F-STL-02** Generate periodic settlement statements per provider (FR-PAY-07).
- **F-STL-03** Execute payouts (batch) + reconcile; handle adjustments (refunds clawback).
- **F-STL-04** Provider + admin settlement reports/dashboards (FR-PAY-07, FR-PRV-08).

### 3.6 Fraud & Reconciliation
- **F-FRD-01** Rule-based suspicious-transaction flags (velocity, amount, mismatch) (FR-PAY-09).
- **F-REC-01** Daily reconciliation: platform ledger vs provider settlement files/webhooks (FR-PAY-10).

---

## 4. Non-Functional Requirements

| Attribute | Requirement | Design Response |
| --- | --- | --- |
| **Correctness** | No lost/duplicated money (BRULE-25) | Double-entry immutable ledger; balances derived; idempotency keys on all money ops. |
| **PCI/Security** | No raw card data (BRULE-26, NFR-SEC-04) | Provider tokenization/hosted fields; store only tokens/refs; secrets in vault. |
| **Reliability** | Survive crashes mid-payment (NFR-AVAIL) | Payment state machine + outbox; webhook-driven eventual confirmation; reconciliation sweeper. |
| **Idempotency** | Retry-safe (flaky networks, NFR-LOC-04) | `idempotency_key` unique per op; webhook dedup by provider event id. |
| **Auditability** | Full financial trail (NFR-AUDIT) | Immutable ledger + hash-chained audit for admin/manual actions. |
| **Localization** | ETB base, multi-currency in (BRULE-22, NFR-LOC-01/02) | Amounts in ETB minor units; FX capture with rate + source + timestamp. |
| **Performance** | Auth ≤ 5s excl. provider (NFR-PERF-03) | Async webhook confirmation; non-blocking capture. |
| **Extensibility** | New providers (NFR-INTEROP) | `PaymentProvider` port + adapter per gateway; strategy selection. |

---

## 5. Domain Model

### 5.1 Aggregates & Entities
- **Payment** (aggregate root) — a payment attempt for an order: method, amount, state, provider refs.
- **Transaction / LedgerEntry** (immutable) — a double-entry posting (debit/credit) to an account.
- **Account** — a ledger account (customer wallet, provider payable, platform revenue, gateway clearing, refunds).
- **Refund** (entity) — a refund against a payment (full/partial), with its own ledger postings.
- **Wallet** (projection over ledger for a customer account).
- **Coupon** (aggregate root) + **CouponRedemption** (usage record).
- **Settlement** (aggregate root) — a provider payout batch + statement lines.
- **PayoutLine** (entity) — one order's contribution to a settlement.

### 5.2 Value Objects
- `Money` (ETB, integer minor units), `Currency`, `FxRate` (rate + source + capturedAt), `PaymentMethod` (TELEBIRR|BANK|CARD|WALLET|COD|CROSS_BORDER), `PaymentStatus`, `RefundStatus`, `IdempotencyKey`, `Fee` (percentage/fixed), `AccountRef` (type + ownerId), `EntryDirection` (DEBIT|CREDIT).

### 5.3 Invariants (money-critical)
- **Every transaction balances**: Σ debits = Σ credits (double-entry). A posting that doesn't balance is rejected.
- A **balance is never stored** as an authoritative mutable field — it's `Σ credits − Σ debits` over an account's entries (cached/materialized for reads, but ledger is truth).
- Every money op carries a **unique reference** and is **idempotent** by `idempotency_key` (BRULE-25) — replays never double-charge/double-refund.
- Order confirmation requires **successful authorization** (BRULE-17) — Orders calls this module; capture happens later at fulfillment.
- Refund amount ≤ captured amount − already-refunded (no over-refund) (BRULE-24).
- Provider payable = Σ(completed order revenue) − platform fee − refunds clawback (BRULE-23); settled net (BRULE-23).
- Raw PAN/CVV **never** enters domain/DB (BRULE-26) — enforced by using provider tokens only.
- All amounts stored in **ETB**; cross-border payments store original currency + `FxRate` + converted ETB (BRULE-22).

**Design rationale — double-entry ledger.** Marketplaces move money between many parties (customer → platform clearing → provider payable → payout). A double-entry ledger is the industry-standard way to guarantee that money is conserved, every movement is traceable, and balances always reconcile. Mutable balance columns are the classic source of financial bugs and are explicitly avoided.

---

## 6. Payment State Machine & Authorize/Capture

**States:** `INITIATED → AUTHORIZED → CAPTURED → SETTLED`; branches: `FAILED`, `VOIDED` (auth cancelled pre-capture), `REFUNDED`, `PARTIALLY_REFUNDED`, `EXPIRED` (auth expired).

| From | Event | To | Notes |
| --- | --- | --- | --- |
| INITIATED | provider auth success (webhook/sync) | AUTHORIZED | funds held; Orders may confirm (BRULE-17) |
| INITIATED | auth fail/timeout | FAILED | Orders compensates (release stock) |
| AUTHORIZED | order fulfilled → capture | CAPTURED | money collected; provider payable accrues |
| AUTHORIZED | order cancelled pre-capture | VOIDED | release hold, no charge |
| CAPTURED | refund (full) | REFUNDED | BRULE-24 |
| CAPTURED | refund (partial) | PARTIALLY_REFUNDED | remaining capturable tracked |
| PARTIALLY_REFUNDED | further refund exhausts the remainder | REFUNDED | ADR-018 |
| CAPTURED | settlement run | SETTLED | included in provider payout |

**Refunds and the terminal state (ADR-018).** A payment may be refunded in several increments, so `PARTIALLY_REFUNDED` is not terminal: the refund that leaves nothing refundable moves the payment to `REFUNDED`, whether that took one request or five. Without that edge two payments in identical financial condition — both repaid in full — would hold different statuses purely because of how many requests it took, making `status` a record of request history rather than of the payment's state. The transition fires only when the remainder reaches zero; `REFUNDED` stays terminal. **Still open, and deliberately not decided here:** `PARTIALLY_REFUNDED` remains terminal with respect to `SETTLED`, so a partially-refunded payment cannot enter a payout batch — which sits uneasily with BRULE-23's payable formula (revenue − fee − refunds clawback) and is left to the settlement task.

**Why authorize-then-capture.** Authorizing pre-confirmation (BRULE-17) guarantees funds exist before we commit stock/pharmacy work, while capturing at fulfillment means customers aren't charged for orders that can't be fulfilled. Some local methods (e.g., certain wallet/Telebirr flows) are **auth+capture combined**; the adapter normalizes this behind the port, and for such methods the order uses immediate capture with refund-on-failure compensation.

---

## 7. Database Design (PostgreSQL via Prisma)

UUID v7 PKs; timestamps; **all money in integer minor units + currency**; append-only where noted.

**payments** — payment aggregate.
- `id`, `order_id` (FK → Module 6), `customer_user_id` (FK), `method`, `status`, `amount`, `currency` (ETB), `original_amount` (nullable), `original_currency` (nullable), `fx_rate` (nullable), `fx_source` (nullable), `provider` (gateway key), `provider_ref` (nullable), `provider_token` (nullable), `idempotency_key` (unique), `authorized_at`, `captured_at`, `failure_reason`, `created_at`, `updated_at`.

**ledger_accounts** — chart of accounts.
- `id`, `type` (CUSTOMER_WALLET|PROVIDER_PAYABLE|PLATFORM_REVENUE|GATEWAY_CLEARING|REFUNDS_PAYABLE|COD_CLEARING|FX_GAINLOSS), `owner_id` (nullable: user/pharmacy), `currency`, `created_at`. Unique (`type`,`owner_id`,`currency`).

**ledger_transactions** — a balanced transaction (groups entries).
- `id`, `reference` (unique, BRULE-25), `type` (PAYMENT|CAPTURE|REFUND|WALLET_TOPUP|WALLET_SPEND|SETTLEMENT|FEE|ADJUSTMENT|FX), `ref_type`, `ref_id`, `description`, `created_at`. Append-only.

**ledger_entries** — double-entry postings (immutable).
- `id`, `transaction_id` (FK), `account_id` (FK), `direction` (DEBIT|CREDIT), `amount`, `currency`, `created_at`.
- Constraint (enforced in app + check): per transaction, Σ debit = Σ credit.

**account_balances** — materialized balance cache (derived; refreshed on posting).
- `account_id` (PK/FK), `balance`, `currency`, `updated_at`. (Rebuildable from entries anytime.)

**refunds**
- `id`, `payment_id` (FK), `amount`, `reason`, `type` (FULL|PARTIAL), `destination` (ORIGINAL|WALLET), `status`, `provider_ref`, `approved_by` (nullable, FK), `idempotency_key` (unique), `created_at`, `completed_at`.

**coupons**
- `id`, `code` (unique), `discount_type` (PERCENT|FIXED), `value`, `min_spend` (nullable), `max_discount` (nullable), `scope` (jsonb: product/category/pharmacy), `starts_at`, `expires_at`, `usage_limit_global` (nullable), `usage_limit_per_user` (nullable), `is_active`, `created_at`.

**coupon_redemptions**
- `id`, `coupon_id` (FK), `user_id` (FK), `order_id` (FK), `discount_amount`, `status` (APPLIED|REVERSED), `created_at`. Unique (`coupon_id`,`order_id`).

**settlements** — provider payout batch.
- `id`, `pharmacy_id` (FK), `period_start`, `period_end`, `gross_amount`, `platform_fee_total`, `refund_clawback`, `net_amount`, `status` (DRAFT|APPROVED|PAID|FAILED), `statement_ref` (pdf), `paid_at`, `created_at`.

**payout_lines**
- `id`, `settlement_id` (FK), `order_id` (FK), `gross`, `platform_fee`, `net`, `created_at`.

**provider_webhooks** — idempotent webhook log (dedup + reconciliation).
- `id`, `provider`, `event_id` (unique per provider), `payload` (jsonb), `processed_at`, `created_at`.

**fraud_flags**
- `id`, `payment_id` (FK), `rule`, `severity`, `details` (jsonb), `status` (OPEN|CLEARED|CONFIRMED), `created_at`.

**outbox** — reliable event publishing (shared pattern).

**Relationships**
- `payments 1—N refunds`; `payments 1—N fraud_flags`.
- `ledger_transactions 1—N ledger_entries N—1 ledger_accounts`.
- `coupons 1—N coupon_redemptions`.
- `settlements 1—N payout_lines`.

**Rationale.** The **chart of accounts + balanced transactions + immutable entries** is the whole game. Example — a capture of a 100 ETB order (10% fee):
`CAPTURE` txn: DEBIT Gateway-Clearing 100; CREDIT Provider-Payable 90; CREDIT Platform-Revenue 10. Balanced, traceable, reconcilable.

---

## 8. Fee & FX Handling

- **Fees** are configurable (NFR-MAINT-03): platform commission (% and/or fixed), possibly per-category. Fee is computed at capture and posted as a `PLATFORM_REVENUE` credit (BRULE-23).
- **Fee clawback on refund (ADR-016).** A refund reverses the platform fee **proportionally and cumulatively**: the fee clawed back is `round(F x (P + r) / G) - round(F x P / G)`, where `G` and `F` are the gross and fee actually posted by the capture, `P` is the total already refunded *and posted*, and `r` is this refund. The provider-payable leg takes the balance (`r - feeClawback`), so the posting balances exactly regardless of rounding. Rounding is half-up on whole minor units, matching `Fee`/`PricingCalculator` so a clawback cannot round differently from the capture it reverses. Because the cumulative form telescopes, a payment refunded in full returns `PLATFORM_REVENUE` to **exactly zero** whatever the number or order of partial refunds — the last one absorbs the residue automatically, with no stored remainder (ADR-006).
- **Coupons and the fee (ADR-019, resolved).** A coupon is **funded by the platform**. `PricingCalculator` computes `platformFee` from the **undiscounted** subtotal and Module 07 credits `PLATFORM_REVENUE` that stored figure unchanged; the pharmacy is credited `grandTotal − fee + discountTotal`, i.e. `subtotal + deliveryFee` — exactly what it would have received had the customer used no coupon. The discount is booked as its own `PROMOTION_EXPENSE` debit, which is what makes the posting balance once the pharmacy is held whole: without it credits exceed debits by the discount. The platform's net position on a discounted order is `fee − discountTotal`, and it can legitimately be negative. Revenue and promotional spend are never netted against each other — they are separate facts, and merging them would make both unreportable. Refunds reverse the promotion leg proportionally alongside the other two (§11.4). The invariant `discountTotal ≤ subtotal` remains enforced by `CouponValidator`'s clamp: without it the gross can fall below the fee and the *capture* fails, days after checkout.
- **FX (diaspora)** — cross-border payments captured in foreign currency are converted to ETB using an `FxRate` (rate + source + timestamp) recorded on the payment; any FX gain/loss posts to `FX_GAINLOSS`. Providers are always settled in ETB (BRULE-22, NFR-LOC-01).

---

## 9. API Design

Base paths: `/api/v1/payments`, `/api/v1/wallet`, `/api/v1/coupons`, `/api/v1/settlements`, `/api/v1/webhooks/payments`, `/api/v1/admin/finance`. Bearer auth (webhooks use provider signature verification, not user auth). Envelope/errors per Module 1 §14. **All mutating ops require `Idempotency-Key`.**

### 9.1 Payments (internal — called by Orders saga; some customer-facing)
- **POST `/payments/authorize`** — `{ orderId, method, amount, currency, token?, returnUrl? }` → `{ paymentId, status, providerRedirect? }`. (BRULE-17)
- **POST `/payments/{id}/capture`** — capture authorized funds (on fulfillment). Idempotent.
- **POST `/payments/{id}/void`** — cancel auth pre-capture.
- **GET `/payments/{id}`** — status + refs.

### 9.2 Webhooks (provider callbacks, FR-PAY-10)
- **POST `/webhooks/payments/{provider}`** — signature-verified; dedup by `event_id`; advances payment state; posts ledger entries. Always 200 on accepted (retry-safe).

### 9.3 Refunds (FR-PAY-05)
- **POST `/payments/{id}/refunds`** — `{ amount?, reason, destination }` (amount omitted = full). Eligibility + over-refund checks. Manual/admin refunds require `finance:refund:any` + audit.
- **GET `/payments/{id}/refunds`** — list.

### 9.4 Wallet
- **GET `/wallet`** — balance (from ledger) + summary. **GET `/wallet/transactions`** — history.
- **POST `/wallet/topup`** — `{ amount, method }` → payment flow.
- (Wallet **spend** is internal, invoked by the checkout saga.)

### 9.5 Coupons
- **POST `/coupons/validate`** — `{ code, cartTotal, items }` → `{ valid, discountAmount, reason? }`. A **preview**: side-effect free, no redemption row, scored against the caller's own cart at fresh Module 03 prices (`cartTotal`/`items` are display assertions that are checked and reported back, never inputs). A pharmacy-scoped coupon answers `PHARMACY_SCOPE_UNRESOLVABLE` here — see §11.7 and ADR-020.
- **Admin CRUD** `/admin/finance/coupons` — `coupon:manage` (Admin).
- Applying and reversing a coupon have **no HTTP route**: both are saga operations invoked in-process through `COUPON_PORT` (§11.7). A customer route that consumed a usage would let a customer spend their own allowance outside a checkout.

### 9.6 Settlement & Finance (`finance:settlement:any`, `finance:report:any`)
- **GET `/settlements`** — provider's own statements (Pharmacy Owner: `settlement:read:org`).
- **POST `/admin/finance/settlements/run`** — `{ period }` → generate draft settlements.
- **POST `/admin/finance/settlements/{id}/approve|pay`** — approve → execute payout. Audited.
- **GET `/admin/finance/reports`** — GMV, revenue, refunds, reconciliation status (FR-PAY-07).
- **GET `/admin/finance/reconciliation`** — ledger vs provider diffs; **GET `/admin/finance/fraud-flags`**.

**Representative errors:** `PAYMENT_AUTH_FAILED, PAYMENT_ALREADY_CAPTURED, INSUFFICIENT_WALLET_BALANCE, REFUND_EXCEEDS_CAPTURED, REFUND_NOT_ELIGIBLE, COUPON_INVALID, COUPON_EXPIRED, COUPON_USAGE_EXCEEDED, WEBHOOK_SIGNATURE_INVALID, IDEMPOTENT_REPLAY, LEDGER_UNBALANCED (internal guard), RBAC_FORBIDDEN, VALIDATION_ERROR`.

---

## 10. NestJS Folder Structure (Clean Architecture)

```
src/modules/payment/
  domain/
    entities/            # Payment, Refund, LedgerTransaction, LedgerEntry, LedgerAccount,
    │                    # Coupon, CouponRedemption, Settlement, PayoutLine, FraudFlag
    value-objects/       # Money, Currency, FxRate, PaymentMethod, PaymentStatus, RefundStatus,
    │                    # Fee, AccountRef, EntryDirection, IdempotencyKey
    events/              # PaymentAuthorized, PaymentCaptured, PaymentFailed, PaymentRefunded,
    │                    # WalletCredited, WalletDebited, CouponRedeemed, SettlementPaid, FraudFlagged
    enums/               # PaymentStatus, RefundStatus, AccountType, LedgerTxnType, SettlementStatus
    repositories/        # IPaymentRepository, ILedgerRepository, IRefundRepository,
    │                    # ICouponRepository, ISettlementRepository, IWebhookRepository
    services/            # LedgerService (double-entry posting + balance guard), FeeCalculator,
    │                    # RefundPolicy, CouponValidator, SettlementCalculator, FraudRuleEngine
  application/
    commands/            # AuthorizePayment, CapturePayment, VoidPayment, RefundPayment,
    │                    # TopUpWallet, SpendWallet, ApplyCoupon, ReverseCoupon,
    │                    # RunSettlement, ApproveSettlement, ExecutePayout, ProcessWebhook
    queries/             # GetPayment, GetWallet, ListWalletTxns, ValidateCoupon,
    │                    # GetSettlements, GetFinanceReports, GetReconciliation
    ports/               # IPaymentProviderPort (per gateway), IPayoutProviderPort, IFxRatePort,
    │                    # IInvoicePort, INotificationPort, IAuditPort, ICachePort
    dtos/  mappers/
  infrastructure/
    persistence/prisma/  repositories/       # Prisma*; balanced-transaction writes in one TX
    providers/           # TelebirrAdapter, BankAdapter, CardProviderAdapter (tokenized),
    │                    # CrossBorderAdapter, MockPaymentProvider  (all implement IPaymentProviderPort)
    payout/              # BankPayoutAdapter
    fx/                  # FxRateAdapter
    webhooks/            # SignatureVerifier, WebhookDedup
    scheduling/          # ReconciliationSweeper, AuthExpirySweeper, SettlementScheduler
    audit/ cache/ outbox/
  interface/
    http/
      controllers/       # PaymentController, WebhookController, RefundController, WalletController,
      │                  # CouponController, SettlementController, AdminFinanceController
      dtos/ guards/       # PermissionsGuard, WebhookSignatureGuard, IdempotencyInterceptor
      decorators/ filters/ interceptors/  # AuditInterceptor on all money ops
    events/              # on OrderCancelled(6)→refund; on OrderCompleted(6)→accrue payable
  payment.module.ts
```

**Rationale.** `LedgerService` is the guarded core — the only way to post money, enforcing balanced double-entry (SRP). Each gateway is an adapter behind `IPaymentProviderPort` (Strategy) so adding Telebirr/bank/card/cross-border providers needs no domain change (Open/Closed). Card adapters use tokenization only (BRULE-26).

---

## 11. Sequence Flows

### 11.1 Authorize (checkout saga, BRULE-17)
```
Orders(6) → POST /payments/authorize {orderId, method, amount} + Idempotency-Key
AuthorizePayment → idempotency check (replay→return existing)
AuthorizePayment → IPaymentProviderPort(method).authorize(amount, token?)
  sync success → Payment=AUTHORIZED; LedgerService: (hold posting if applicable)
  redirect/async → Payment=INITIATED; return providerRedirect (customer completes)
AuthorizePayment → outbox(PaymentAuthorized|Initiated); IAuditPort
→ {paymentId, status, providerRedirect?}
```

### 11.2 Webhook Confirmation (FR-PAY-10)
```
Provider → POST /webhooks/payments/telebirr (signed)
ProcessWebhook → WebhookSignatureGuard verify  [WEBHOOK_SIGNATURE_INVALID]
ProcessWebhook → dedup by event_id (provider_webhooks)  [replay→200 no-op]
ProcessWebhook → map event → advance Payment state (INITIATED→AUTHORIZED/FAILED)
ProcessWebhook → notify Orders via outbox(PaymentAuthorized/PaymentFailed)
→ 200
```

### 11.3 Capture at Fulfillment
```
Orders(6) OrderReady → POST /payments/{id}/capture
CapturePayment → provider.capture; Payment=CAPTURED
CapturePayment → LedgerService.post(CAPTURE):
   DEBIT Gateway-Clearing (amount)                  [what the customer actually paid]
   DEBIT Promotion-Expense (discountTotal)          [platform-funded coupon, ADR-019; omitted if 0]
   CREDIT Provider-Payable (amount − fee + discountTotal)   [= subtotal + deliveryFee]
   CREDIT Platform-Revenue (fee)    [FeeCalculator, BRULE-23]
CapturePayment → outbox(PaymentCaptured); IAuditPort
```

### 11.4 Refund (BRULE-24)
```
Orders/Admin → POST /payments/{id}/refunds {amount, reason, destination}
RefundPayment → RefundPolicy: amount ≤ captured − refunded  [REFUND_EXCEEDS_CAPTURED]
RefundPayment → destination=ORIGINAL → provider.refund | WALLET → LedgerService credit wallet
RefundPayment → LedgerService.post(REFUND) (reverse provider-payable/revenue/promotion-expense
                 proportionally, cumulative + half-up, provider leg absorbs the balance
                 -- ADR-016 + ADR-019; legs read back off CAPTURE-<paymentId>, never re-derived)
RefundPayment → Payment=PARTIALLY_REFUNDED, or REFUNDED once nothing remains refundable
                 (ADR-018)
RefundPayment → notify; IAuditPort
```

**Who decides eligibility (ADR-017).** Module 07's gate is **payment state only** — refundable iff `CAPTURED` or `PARTIALLY_REFUNDED`, plus BRULE-24's arithmetic invariant and, for a manual refund, `finance:refund:any` + audit. It holds no order-status whitelist: BRULE-24's "eligible cancellations, failed deliveries, verified disputes" are owned by Module 06 (BRULE-20), Module 08 (`DeliveryStatus.FAILED`) and Module 16 (`DisputeCase`) respectively, and each reaches Module 07 as a `SYSTEM` refund from that module's saga or a `MANUAL` refund with a recorded approver. An order cancelled *before* capture is compensated by §6's `AUTHORIZED -> VOIDED`, not by a refund. Note BRULE-24's three triggers are not exhaustive — the domain event catalog also routes `AppointmentCancelled` and `BookingCancelled` here.

### 11.5 Settlement Run (BRULE-23)
```
SettlementScheduler/Admin → POST /admin/finance/settlements/run {period}
RunSettlement → SettlementCalculator: per pharmacy, Σ completed orders' Provider-Payable − refund clawback
RunSettlement → create Settlement(DRAFT) + payout_lines + statement
Admin → approve → ExecutePayout → IPayoutProviderPort.pay; Payment(s)=SETTLED
ExecutePayout → LedgerService.post(SETTLEMENT): DEBIT Provider-Payable; CREDIT Gateway-Clearing
→ Settlement=PAID; notify provider; IAuditPort
```

**Built:** the first three lines. `RunSettlement`, the `DRAFT` statement and its `payout_lines` are
implemented and are **read-only over the ledger** — generating a statement posts nothing (F-STL-01/02).

**Not built:** everything from `approve` onward. `IPayoutProviderPort` does not exist, no `SETTLEMENT`
posting is ever written, `Settlement.paidAt` is always null and no payment reaches `SETTLED`
(F-STL-03). Those three lines hide a payout lifecycle, an approval authority, a payout destination
that **does not exist anywhere in the schema**, a two-key idempotency contract and a set of
ambiguous-outcome rules — see **§15, Payout Execution — Readiness Review**, and ADR-022..026.

### 11.6 Wallet Spend (checkout)
```
Orders(6) → SpendWallet {userId, amount, orderId}
SpendWallet → balance = LedgerService.balance(wallet)  [INSUFFICIENT_WALLET_BALANCE]
SpendWallet → LedgerService.post(WALLET_SPEND): DEBIT Customer-Wallet; CREDIT Gateway-Clearing
→ applied to order total
```

### 11.7 Coupon Application & Reversal (checkout / cancellation)
```
Orders(6) step 5 -> ICouponPort.validate {userId, code}      [quote only, no redemption row]
Orders(6) step 6 -> Order created with discountTotal          [PricingCalculator owns the totals]
Orders(6) step 6+ -> ICouponPort.apply {code, orderId, userId}
                     -> CouponValidator over the order's own order_lines
                     -> COUNT(APPLIED) < limits, then INSERT redemption   [one Serializable txn]
                     -> coupon.redeemed
Cancellation      -> ICouponPort.reverse {orderId, code} -> APPLIED -> REVERSED -> coupon.reversed
```

**Where a coupon is evaluated, and why there (ADR-020).** Module 06 §6's saga puts *match* at step 3
and *compute totals (+ coupons/wallet)* at step 5, so by the time a coupon is scored the dispensing
pharmacy is already chosen and all three scope dimensions — product, category, pharmacy — are
decidable. `POST /coupons/validate` (§9.5) is a **pre-checkout preview** against the customer's cart;
a cart has no pharmacy, so a pharmacy-scoped coupon there answers `PHARMACY_SCOPE_UNRESOLVABLE`
rather than guessing. That answer is provisional by design, not a defect, and clients must treat
step 5's figure as authoritative.

**Quote and redemption are separate steps, because they must be.** A redemption row requires an
`order_id` (§7's `coupon_redemptions`, and its `(coupon_id, order_id)` unique index is what makes an
application idempotent), and no order exists at step 5. So step 5 *computes* the discount that feeds
`PricingCalculator.discountTotal`, and the redemption is written once the order exists. The two
figures must agree: the discount is computed from the same line totals the order then freezes into
`order_lines`, and `apply` re-scores those committed lines rather than trusting a number carried
across the step boundary.

**Compensation.** Module 06 §6's step-5 compensation is "refund wallet/coupon". For coupons that is
`ICouponPort.reverse`, which is idempotent, so a saga may retry it freely.

**Reversing a coupon moves no money, and is not a refund.** A reversal flips one redemption from
`APPLIED` to `REVERSED`; since both usage limits are counted over `APPLIED` rows, that alone returns
the usage to the pool — there is no compensating write and no ledger posting. It deliberately does
**not** touch `Order.discountTotal`, the captured amount, or any account: the customer was charged
the discounted total, and returning that money is §11.4's refund flow against the payment, driven by
whichever module owns the cancellation (ADR-017). Coupon usage state and money movement are separate
concerns, and a coupon reversal that also moved money would double-count every cancellation.

**One coupon per order (ADR-021).** §9's `POST /checkout` carries `couponCode?` and §9.5 validates a
single `code`; stacking is defined nowhere and must be refused by the integration.

#### 11.7.1 The integration contract, against the code as it actually stands

Written for whoever implements the Module 06 integration. Every line below was checked against the
implementation rather than against the parent design, because the two differ in two places that
matter. Nothing here is implemented yet: `COUPON_PORT` is exported by `PaymentModule` and has no
consumer.

| # | Step | Contract | Status |
| --- | --- | --- | --- |
| 1 | Request | `POST /checkout` accepts an optional coupon code | **Missing.** See below. |
| 2 | Saga step 5 | Evaluate after matching, never before (ADR-020) | Already the saga's order |
| 3 | Saga step 5 | `ICouponPort.validate` gives the discount quote | **Contract gap.** See below. |
| 4 | Saga step 5 | `PricingCalculator` composes the totals; Module 07 never does | Ready — no change needed |
| 5 | After step 8 | `ICouponPort.apply` writes the redemption | Ready |
| 6 | After step 8 | `apply` runs in *its own* transaction, not the order's | ADR-014 seam. See below. |
| 7 | Cancellation | `ICouponPort.reverse` compensates | Ready, and idempotent |
| 8 | All of it | Gated on ADR-019 | **Blocked.** See §11.7.2. |

**(1) The checkout DTO does not carry `couponCode` yet.** The parent design's §9 body lists it, but
the implemented Slice-1 `CheckoutDto` deliberately does not, and says so: `chosenPharmacyId`/
`couponCode`/`useWallet` are listed among the fields "deliberately absent rather than
accepted-and-ignored", because no corresponding `CheckoutInput` field exists. So the integration's
first change is adding the field to `CheckoutDto` *and* `CheckoutInput` — until then no coupon code
can reach the saga at all. It must be validated the way `CouponCode` validates it (trimmed,
upper-cased, `A-Z 0-9 - _`, 3–32 characters) rather than passed through raw.

**(4) `PricingCalculator` needs no change.** It already accepts an optional `discountTotal`, declared
for exactly this purpose ("a future Slice-2 caller can pass a real value without this function's
shape changing"). The integration passes the quote from step 5 into the existing call. It must not
gain a coupon parameter, a second discount formula, or knowledge of Module 07 (ADR-019 clause 1).

**(3) `ICouponPort.validate` cannot yet answer step 5's question.** `ValidateCouponInput` is
`{ customerUserId, code, cartTotal? }`, and `ValidateCouponQuery` always scores the caller's *active
cart* through `CouponLineResolver.forActiveCart`, which resolves every line with `pharmacyId: null`.
That is right for the preview endpoint and wrong for step 5, which has already matched a pharmacy
and already re-priced its lines: asked as it stands, it would return `PHARMACY_SCOPE_UNRESOLVABLE`
for exactly the coupon ADR-020 says is decidable at that point, and it would re-read the cart a
second time at a different instant than the checkout's own step-4 re-price. The integration must
therefore extend the inbound contract so a quote can be scored against caller-supplied, already-
matched, already-priced lines. Two constraints on that extension:

- it is **in-process only**. A pharmacy accepted over HTTP would be the client-chosen dispensing
  pharmacy ADR-020 clause 3 forbids; `POST /coupons/validate` must keep its cart-only shape.
- the quote and the redemption must agree. `apply` re-scores the order's committed `order_lines`
  rather than trusting a number carried across the step boundary, so the lines handed to the quote
  must be the same ones the order then freezes.

**(6) `apply` cannot join the order-creation transaction, and must not pretend to.** ADR-014 settles
this: Prisma cannot honour a single `$transaction` spanning two independently-owned unit-of-work
implementations without collapsing ADR-001/ADR-002's module boundary, and accordingly no inbound
port in this codebase takes a `tx` — `ApplyCouponCommand` opens its own `Serializable` transaction
through `runWithPaymentRetry`, exactly as `IInventoryPort.reserve` does. So the redemption is
written *after* step 8 commits, over ADR-014's accepted eventual-consistency seam. That leaves a
window the integration must handle explicitly rather than discover:

- **`apply` fails after the order committed** — the order exists with `discountTotal > 0` and no
  `APPLIED` redemption. The customer is charged the discounted total while the coupon's usage was
  never consumed, so the code stays spendable. Silence is not an option here; whether Module 06
  retries or compensates the order is a Module 06 decision, and it belongs in that task's ADR.
- **`apply` succeeds and a later step fails** — compensate with `ICouponPort.reverse`, which is
  idempotent and may be retried freely.

**One coupon per order is the caller's check for now (ADR-021).** `ApplyCouponCommand` enforces only
one redemption *per coupon* per order — §7's `(coupon_id, order_id)` unique index — so a second,
*different* coupon is still accepted. The integration adds "no `APPLIED` redemption exists for this
`orderId`", inside the same `Serializable` transaction as the insert, for the same reason the usage
limits are counted there: it is a cross-row condition no row-level constraint can express. A
`@@unique([orderId])` would be wrong — a `REVERSED` row would then permanently block a legitimate
re-application after a cancellation.

#### 11.7.2 ADR-019 is resolved: coupons are platform-funded

The gate this section previously imposed is **lifted**. Product decided (2026-09-11) that a coupon
is funded entirely by the platform, and Module 07 now implements it, so coupons may be wired into
checkout with a non-zero commission.

What the integration inherits, rather than has to decide:

- **The pharmacy is never charged for a promotion.** `PROVIDER_PAYABLE` is credited
  `grandTotal − fee + discountTotal`, which is `subtotal + deliveryFee` — the same figure an
  un-discounted order produces. A coupon changes what the *customer* pays and what the *platform*
  spends, and nothing else.
- **`Order.platformFee` and `PricingCalculator` are untouched.** Module 07 still reads the stored
  fee rather than deriving one, so there remains exactly one owner of order pricing.
- **The discount must reach Module 07 through `Order.discountTotal`.** That is the only value
  capture reads; it is never re-derived from `coupon_redemptions`, because `grandTotal` was
  computed from it inside Module 06's checkout transaction. An integration that wrote a redemption
  without also setting `discountTotal` would produce a coupon that cost the platform nothing and
  discounted nothing — the two must be set together, in the same transaction as the order.
- **`discountTotal ≤ eligible subtotal` is still load-bearing**, now for the capture rather than
  the payable: it keeps `grandTotal ≥ platformFee`, and `Fee.applyTo` still rejects a fee larger
  than the gross.

Still binding on the integration: ADR-020 (evaluate after matching) and ADR-021 (one coupon per
order, a check the integration must add).

---

## 12. Error Handling

Reuses Module 1 §14. Money errors are hard and trigger saga compensation in Orders. Critical internal guard: `LEDGER_UNBALANCED` (a posting that doesn't balance is rejected before commit — a bug tripwire). Idempotent replays return the original result (`IDEMPOTENT_REPLAY`) — never double-charge. Webhook failures return non-2xx only when we want provider retry; signature failures are logged as security events.

---

## 13. Logging & Auditing

The **ledger is the financial audit trail** (immutable). Additionally hash-chained `audit_logs` records: payment authorized/captured/failed/voided, every refund (actor + reason, manual approvals), coupon create/redeem/reverse, settlement run/approve/pay (actor), fraud flags raised/cleared/confirmed, reconciliation runs + discrepancies, webhook signature failures. **Never log** card data, tokens, or provider secrets. Reconciliation reports retained per financial-record retention policy.

---

## 14. Future Scalability & Evolution

- **New gateways/methods** — add adapters behind `IPaymentProviderPort`/`IPayoutProviderPort` (Chapa, M-Pesa, Stripe for diaspora) with zero domain change.
- **Ledger at scale** — partition `ledger_entries`/`ledger_transactions` by time; `account_balances` materialized and incrementally updated; periodic snapshot balances to bound recompute.
- **Reliability** — outbox + webhook-driven eventual consistency + reconciliation sweeper make payments crash-safe (NFR-AVAIL).
- **Fraud** — rule engine now; pluggable ML scoring later behind `FraudRuleEngine` interface (FR-PAY-09).
- **Insurance/claims (future)** — model as additional ledger account types + settlement flows without schema upheaval.
- **Extraction-ready** — a natural microservice; depends on Orders/Identity via ports and events. As a money service it would own its DB and expose a strict API + webhooks.

---

## 15. Payout Execution — Readiness Review

> **Nothing in this section is implemented, and nothing in it moves money.** It is the design work
> that must land before `ExecutePayout` may be written. §11.5's last three lines — `IPayoutProviderPort.pay`,
> the `SETTLEMENT` posting, `Settlement=PAID` — are one line of pseudocode each and hide every
> decision below. The settlement foundation (F-STL-01/02) and its HTTP surface are built and are
> read-only by construction; **F-STL-03 is not started**.
>
> Each subsection ends with **DECIDED** or **OPEN**. An OPEN item is a real blocker, not a
> formality: implementing around it means guessing about money.

### 15.1 What exists today (inspected, not assumed)

| Thing | State |
| --- | --- |
| `Settlement` aggregate, `statements`, `payout_lines` | Built. Immutable — `ISettlementRepository` has **no update and no delete**. |
| `SettlementStatus` enum | `DRAFT`, `APPROVED`, `PAID`, `FAILED`. No in-flight state. |
| `Settlement.paidAt` | Column exists, always `null`. Nothing writes it. |
| Provider payable derivation | Built (`ProviderPayableService`), read-only over the ledger. |
| `RunSettlement` | Built. Posts nothing. Idempotent on `(pharmacyId, periodStart, periodEnd, currency)`. |
| HTTP: list/detail/run | Built (`settlement:read:org`, `finance:settlement:any`). All read-only. |
| `AccountingReconciliationService` | Built, read-only, 8 anomaly kinds. Knows nothing about payouts. |
| `LedgerTransactionType.SETTLEMENT` | Enum value exists. **Zero postings of this type are ever written.** |
| `PaymentStatus.SETTLED` | Enum value exists. Nothing transitions to it. |
| `IPayoutProviderPort` | **Does not exist.** Named once, in §11.5. |
| Payout destination (bank / MSISDN / beneficiary) | **Does not exist anywhere in the schema.** |
| `ApprovalRequest` + `ApprovalEntityType.PAYOUT` (Module 16) | Model exists; no payout uses it. |
| Telebirr | Fail-closed placeholder; `TELEBIRR_MISSING_CONTRACT` enumerates the gap in code. |

A repository-wide search for payout implementation outside Module 07 found none: the only other
mentions are `ApprovalEntityType.PAYOUT` (Module 16, unused) and Module 08's F-ERN-02, which
defers driver earnings *to* this module.

### 15.2 Lifecycle — **DECIDED**, with one OPEN branch

The design's flow is `DRAFT → APPROVED → PAID` with `FAILED`. That is insufficient, and the
insufficiency is demonstrable rather than stylistic.

`IPaymentProviderPort` already establishes the module's ambiguity discipline: capture and refund
both carry an `UNKNOWN` outcome, and both doc comments state that collapsing it into `FAILED` is
the defect that causes a double movement. A payout inherits that problem in its worst form — the
money leaves the platform. With only `{APPROVED, PAID, FAILED}`:

- leaving an in-flight payout `APPROVED` makes it indistinguishable from one nobody has attempted,
  so any retry sweep re-pays it;
- marking it `FAILED` frees it to be paid again, which is precisely the double-payout
  `ProviderRefundOutcome`'s doc comment forbids.

There is therefore no state in which an attempted-but-unconfirmed payout can honestly sit. The
required lifecycle is:

```
DRAFT ──approve──► APPROVED ──pay──► PROCESSING ──confirmed──► PAID
                                          │
                                          ├──positively declined──► FAILED ──retry──► PROCESSING
                                          └──undeterminable───────► PROCESSING (stays; reconciliation resolves)
```

`PROCESSING` is a **new enum value** the implementing task must add; this task adds no schema
change. `FAILED` means *the provider positively declined and no money moved* — never an ambiguous
result. See **ADR-023**.

**OPEN — cancellation.** Whether a `DRAFT` or `APPROVED` statement can be withdrawn, and by whom,
is unresolved. The repository has no delete and no update path today, so a wrongly-cut statement
is currently permanent. Two candidate models — a `CANCELLED` terminal state, or superseding the
statement with an adjustment — have different audit consequences and this is a finance decision,
not an engineering one. Do not invent one. (See Open Question 10.)

### 15.3 Approval authority — partly **DECIDED**, maker/checker **OPEN**

Inspected: the RBAC catalog grants `finance:settlement:any` to `FINANCE_OFFICER` alone (plus
`SUPER_ADMIN` by wildcard). `ADMIN` does **not** hold it; `ADMIN` holds `finance:report:any`.
`PHARMACY_OWNER` holds only `settlement:read:org`, which reaches `/settlements` and nothing under
`/admin`.

**DECIDED — disbursement must not share a permission with generation.** `finance:settlement:any`
today authorizes three things of very different consequence: a read, a read-only generation, and —
if pay were added under it — irreversibly sending money. Generating a statement is safe enough to
schedule; paying one is not. A separate permission is required for `pay` regardless of how the
maker/checker question resolves. Candidate name following the catalog's `resource:action:scope`
convention: `finance:payout:any`. **Not granted by this task.**

**DECIDED — a provider can never approve or pay its own statement.** `settlement:read:org` is
org-scoped and the finance routes are platform-wide; nothing in the design contemplates a pharmacy
authorizing its own disbursement.

**OPEN — maker/checker separation.** Whether the user who generated (or approved) a statement may
also pay it is a financial-control and compliance decision. The repository can express it:
Module 16's `ApprovalRequest` already carries `requestedByUserId` and `decidedByUserId` and already
defines `ApprovalEntityType.PAYOUT`, and `SETTLEMENT_GENERATED` audit entries already record
`actorUserId`. What is missing is the *rule*. Sub-questions, all OPEN:

- Must approver ≠ generator? Must payer ≠ approver?
- Does `SUPER_ADMIN`'s wildcard bypass the separation, or is separation enforced in the domain
  where a wildcard cannot reach it? (A control that a wildcard defeats is not a control.)
- Is `ADMIN` in scope at all, or does the existing catalog split — platform administration vs.
  finance authority — stand?
- Is there an amount threshold above which a second approver is required?

### 15.4 Payout destination — **OPEN (hard blocker)**

**There is no payout destination in this repository.** `Pharmacy` carries `displayName`, ratings,
`transactingStatus`, `licenseStatus` and timestamps; `Organization` carries name, status, owner and
licence. Neither has a bank account, an account name, a branch/SWIFT identifier, a Telebirr MSISDN
or merchant id, or any verified beneficiary record. A repository-wide schema search for
bank/account/IBAN/SWIFT/MSISDN fields returns only `PaymentMethod.BANK_TRANSFER` — a customer-side
method, not a provider destination.

This is the largest single blocker: `ExecutePayout` cannot be written at all, because there is
nothing to address the payment to.

**DECIDED — the platform refuses to pay an unverified or absent destination (fail-closed).** This
is the same discipline `TelebirrAdapter` already applies: refuse precisely rather than guess. A
payout attempted against a missing, unverified or changed destination must be refused before any
provider call, not attempted and reconciled afterwards — a misdirected transfer is not recoverable
by the platform. See **ADR-026**.

**DECIDED — the destination is a separate, verified entity referenced by scalar id.** Not columns
on `Pharmacy`: a beneficiary has its own verification lifecycle, its own change history and its own
access rules, and ADR-002 means Module 07 references it by UUID rather than joining it.

**OPEN**, and each needs a product/compliance answer before schema work:

- Which module owns the beneficiary record — Module 04 (pharmacy profile) or Module 16 (admin
  verification, which already has the approval machinery)?
- The field set per rail (bank: account number, account name, bank code, branch; Telebirr: MSISDN
  or merchant id), which cannot be fixed before Open Question 4 names the rails.
- Verification: who verifies a beneficiary, against what evidence (micro-deposit, licence match,
  document review), and what invalidates it?
- Change control: a beneficiary change is a high-value fraud target. Cooling-off period before a
  changed destination may receive a payout? Re-verification? Notification to the owner?
- Encryption at rest: account identifiers are sensitive. ADR-009's envelope-encryption pattern is
  the existing precedent; whether it applies here is unconfirmed.
- Does an unverified destination block *generation* (no), or only *payout* (assumed yes)?

**No sensitive field is added by this task.**

### 15.5 Provider abstraction — **DECIDED**

A payout needs its own port, `IPayoutProviderPort`. This is not an invention: §11.5 already names
`IPayoutProviderPort.pay`.

The separation is substantive, not cosmetic. `IPaymentProviderPort`'s five operations are all
*collection-side* — they address a `Payment` and a customer's instrument, and every request type it
defines (`ProviderAuthorizationRequest`, `ProviderPaymentOperationRequest`, `ProviderRefundRequest`)
carries `orderId`, `customerUserId` or `paymentId`. A payout has none of those: it addresses a
settlement and a provider's beneficiary account. Bolting `pay()` onto the payment port would put a
method on every existing adapter that cannot implement it, and would hand payout code a
`supports(method: PaymentMethod)` question that is meaningless for disbursement. The registry is
also collection-shaped: `forMethod`/`forKey` resolve the gateway holding a customer's money, which
is not how a payout rail is chosen.

The port's shape, following the existing port's conventions exactly:

- `pay(request) → PayoutResult` — idempotent on the attempt's stable reference (§15.6), called
  outside any database transaction.
- `getStatus(payoutReference) → PayoutResult` — the resolution path for an ambiguous outcome.
  `IPaymentProviderPort` has no status-lookup method and that gap is already felt: `ReconciliationService`
  reports every stuck payment as "not automatically resolvable" because no `IProviderStatusPort`
  adapter is bound. Payout must not repeat that.
- `PayoutOutcome` normalized to the same five-valued shape the module already uses:
  `PAID | ALREADY_PAID | PENDING | FAILED | UNKNOWN`, where `ALREADY_PAID` is the idempotent-retry
  answer and `UNKNOWN` must never be collapsed into `FAILED`.

See **ADR-022**. The interface is **not written** by this task — a type contract with no rail
behind it would fix decisions Open Question 4 has not made.

### 15.6 Idempotency — **DECIDED**

The module's discipline is a deterministic natural key with a unique index behind it
(`ledger_transactions.reference`, `payments.idempotencyKey`, `coupon_redemptions (couponId, orderId)`,
`settlements (pharmacyId, periodStart, periodEnd, currency)`). Payout follows it, and needs **two
distinct keys** because it has two distinct exactly-once guarantees.

| Guarantee | Key | Enforced by |
| --- | --- | --- |
| The ledger records this settlement's payout **once, ever** | `SETTLEMENT-<settlementId>` | `ledger_transactions.reference` unique index |
| A given provider call is not duplicated by a retry | `PAYOUT-<payoutAttemptId>` | provider-side idempotency + a unique index on the attempt row |

Why two rather than one: keying the provider call on the settlement would make a legitimate retry
after a *positive decline* indistinguishable from a duplicate, and a provider idempotent on that key
would return the original failure forever. This is exactly why `ProviderRefundRequest` is keyed on
`refundId` and not `paymentId` — "partial refunds mean one payment may have several distinct,
legitimate refunds, so keying on the payment would make the second one indistinguishable from a
retry of the first". A settlement may likewise need several attempts, of which at most one moves
money.

That implies a **payout attempt entity** — one row per provider call, committed *before* the call,
carrying the reference sent to the provider, the outcome and the provider's own reference. This is
the same ordering `AuthorizePaymentCommand` uses and for the same stated reason: it is the commit
before the call, not the constraint alone, that makes the external side effect idempotent.

An HTTP `Idempotency-Key` header is **not** sufficient and must not be the authoritative mechanism.
It protects one client's retry; it says nothing about a scheduler, a reconciliation sweep or a
second operator. See **ADR-024**.

### 15.7 Money movement — **DECIDED**

| Step | Ledger | Statement |
| --- | --- | --- |
| Generate | **Nothing.** Already true and asserted by tests. | `DRAFT` |
| Approve | **Nothing.** Approval is authorization to pay, not payment. | `APPROVED` |
| Pay — attempt | Nothing yet. Attempt row committed before the provider call. | `PROCESSING` |
| Pay — confirmed | `SETTLEMENT` posting, exactly once: `DEBIT PROVIDER_PAYABLE; CREDIT GATEWAY_CLEARING` | `PAID`, `paidAt` set |
| Pay — declined | **Nothing.** No money moved. | `FAILED` |
| Pay — ambiguous | **Nothing.** Writing either way would be a guess. | stays `PROCESSING` |

The posting is keyed `SETTLEMENT-<settlementId>`, so the unique index makes it exactly-once even
against a concurrent double-pay: the second writer's transaction fails and resolves by reading the
winner, the pattern `RunSettlementCommand` and `ApplyCouponCommand` already use.

**The payable is consumed by the posting itself.** Because balances are derived (ADR-006), debiting
`PROVIDER_PAYABLE` reduces the balance a *later* period's statement will derive; no "frozen" flag is
needed and none should be added, since a mutable freeze flag beside a derived balance is exactly the
authoritative-mutable-balance ADR-006 forbids. This has a consequence worth stating: `netPayable` is
a period figure, while the account balance is cumulative, and a payout must debit the **statement's**
`netPayable`, not the account's current balance — those differ the moment a refund posts after the
period closed.

**Ambiguity never writes.** A retry after an ambiguous response must consult the provider's status
endpoint (§15.5) or the reconciliation trail before attempting again. See **ADR-025**.

### 15.8 Provider failure and ambiguous outcomes

| Scenario | Required behaviour | Status |
| --- | --- | --- |
| Synchronous success | Post `SETTLEMENT`, `PAID`, `paidAt`, audit, notify provider. | DECIDED |
| Synchronous decline | No posting. `FAILED` with the sanitized reason. Retry permitted under a **new attempt id**. | DECIDED |
| Timeout / network failure | No posting. Stays `PROCESSING`. Never `FAILED`. | DECIDED |
| Provider says "already processed" | `ALREADY_PAID` → treated as success, posting written under the settlement key (idempotent), `PAID`. | DECIDED |
| Async callback confirming | Same terminal handling as synchronous success; the posting's unique key makes the order of callback vs. poll irrelevant. | DECIDED |
| Duplicate callback | Absorbed by the `SETTLEMENT-<settlementId>` unique index — the second is a replay, not an error. Mirrors `ProcessWebhookCommand`. | DECIDED |
| Callback after local timeout | Resolves a `PROCESSING` statement. The callback is authoritative over the timeout. | DECIDED |
| Status undeterminable after retries | Stays `PROCESSING`; surfaces as a reconciliation anomaly for a human. **No automatic repair.** | DECIDED |
| Callback authenticity | **OPEN** — depends on the rail's signature scheme (Open Question 11). `ProviderWebhook` + signature verification is the existing pattern, but a payout callback is a different contract from a collection callback and cannot be assumed identical. | OPEN |
| Partial payout / provider pays less than requested | **OPEN** — no rail contract yet says whether this is possible. | OPEN |
| Provider reverses a settled payout (recall/bounce) | **OPEN** — a returned transfer needs a compensating posting and a statement state the design does not define. | OPEN |

### 15.9 Settlement freezing — partly **DECIDED**

- **Can an approved statement be regenerated?** **No — already structurally impossible.**
  `ISettlementRepository` has no update method, and `RunSettlement` replays rather than
  regenerating. Nothing needs to be built.
- **Is the amount snapshotted at approval?** **It is snapshotted at *generation*, which is
  stronger.** `settlements.netAmount` and `payout_lines` are written once from the ledger and never
  recomputed; reconciliation re-derives and *reports* a divergence rather than correcting it. Pay
  must disburse the stored `netPayable`, never a fresh derivation — a re-derived amount could differ
  from the one an operator approved.
- **Can new captures or refunds enter an approved period?** **Yes, and they must be allowed to.**
  The ledger is append-only and half-open periods mean a late refund posts with its own timestamp; a
  refund for an order in a closed period is a legitimate, unavoidable event. It does **not** alter
  the approved statement — it cannot, the statement is immutable — and reconciliation surfaces it as
  a `SETTLEMENT_TOTAL_MISMATCH` today.
- **Must a later refund produce an adjustment?** **Design-level: yes.** The clawback must reach the
  provider somehow, and the only non-destructive route is a subsequent period's statement picking up
  the negative delta — which `ProviderPayableService` already does naturally, since it sums whatever
  postings fall in the period. **OPEN:** whether a clawback that exceeds the next period's payable
  (a provider owing the platform money) is carried forward, invoiced, or recovered another way. That
  is a commercial decision.
- **Can a `DRAFT` statement be deleted or rebuilt?** Currently no. See the OPEN cancellation
  question in §15.2.

### 15.10 Reconciliation of payouts — design **DECIDED**, unbuilt

`AccountingReconciliationService` knows nothing about payouts today. A payout introduces five facts
that must be separately visible, because any pair of them can disagree:

1. **Settlement payable** — `settlements.netAmount` (stored).
2. **Payout requested** — the attempt row: reference sent, amount, destination, when.
3. **Provider result** — the normalized outcome plus the provider's own reference.
4. **Payout ledger posting** — presence or absence of `SETTLEMENT-<settlementId>`.
5. **Final provider-confirmed state** — from the status endpoint or callback.

New anomaly kinds, following the existing eight-kind naming:

- `PAYOUT_POSTING_MISSING` — `PAID` with no `SETTLEMENT` posting.
- `PAYOUT_POSTING_ORPHANED` — a `SETTLEMENT` posting whose statement is not `PAID`.
- `PAYOUT_AMOUNT_MISMATCH` — posting amount ≠ statement `netPayable`.
- `PAYOUT_STUCK_PROCESSING` — `PROCESSING` beyond a threshold; the one that catches a real
  ambiguous outcome.
- `PAYOUT_DESTINATION_CHANGED` — the beneficiary differs from the one the attempt used.
- `PAYOUT_UNCONFIRMED` — provider state unknown after the retry budget.

**Read-only, and reporting only.** No automatic repair, for the reason already recorded: a repair is
a guess about which side is right, written where it cannot be withdrawn.

### 15.11 API contract — documented, **not implemented**

§9.6's `POST /admin/finance/settlements/{id}/approve|pay` is the design's own naming and should be
kept. Required future surface:

| Endpoint | Purpose | Permission |
| --- | --- | --- |
| `POST /admin/finance/settlements/{id}/approve` | `DRAFT → APPROVED`. Moves no money. | existing `finance:settlement:any` |
| `POST /admin/finance/settlements/{id}/pay` | `APPROVED → PROCESSING`, attempts the payout. | **new**, e.g. `finance:payout:any` (§15.3) |
| `GET /admin/finance/settlements/{id}/payout` | Attempts, provider references, outcomes. | `finance:settlement:any` |
| `GET /admin/finance/reconciliation` | Already built; gains the §15.10 anomaly kinds. | existing `finance:report:any` |
| Provider payout callback | Rail-specific, `@Public()` + signature-verified. | n/a — **OPEN**, §15.8 |

Already built and unaffected: `GET /settlements`, `GET /settlements/{id}`,
`GET /admin/finance/settlements`, `GET /admin/finance/settlements/{id}`,
`POST /admin/finance/settlements/run`. **No permission is granted by this task.**

### 15.12 External provider prerequisites

Telebirr's gap is already enumerated in code as `TELEBIRR_MISSING_CONTRACT`, and that fail-closed
approach stands unchanged: **no payout API contract is guessed here.** A payout rail needs its own
list, because disbursement is a different product from collection and the two contracts differ even
at the same provider:

1. Payout API base URLs (sandbox + production) and the commercial agreement enabling disbursement.
2. Authentication for outbound payout calls — often a distinct credential set from collection,
   frequently with additional controls (IP allow-list, signing key, dual credentials).
3. Payout request/response schema, including how a beneficiary is addressed.
4. The provider's idempotency semantics: field name, uniqueness scope, retention window, and what
   a repeat of an already-processed reference returns.
5. Status-query endpoint and/or callback contract — **mandatory**, not optional. Without it an
   ambiguous payout is unresolvable and §15.8's `PROCESSING` state has no exit.
6. Callback signature algorithm, signed-payload construction and header name.
7. Failure/decline code catalogue, and which codes are safely retryable.
8. Supported currencies and whether payout currency must match the settlement currency (ETB).
9. Beneficiary verification: name-match rules, pre-registration requirements, whether the provider
   validates the destination before accepting a payout.
10. Limits: per-transaction and per-day caps, minimum payout amount, batch support and batch
    semantics (is a batch atomic?).
11. Settlement timing: when funds actually land, and whether the provider can recall a transfer.
12. Sandbox credentials for integration testing against a rail that does not move real money.

Until 1–7 exist for a named rail, `ExecutePayout` must not be written.

### 15.13 Summary

| Area | Decision | Status |
| --- | --- | --- |
| Lifecycle | `DRAFT → APPROVED → PROCESSING → PAID`, `FAILED` = positive decline only. `PROCESSING` is a required new enum value (ADR-023). | **DECIDED** (cancellation branch OPEN) |
| Approval authority | Pay must not share `finance:settlement:any` with generation; a provider can never approve its own statement. | **DECIDED** (maker/checker, SUPER_ADMIN bypass, ADMIN scope OPEN) |
| Payout destination | No destination exists anywhere. Must be a separate verified beneficiary referenced by scalar id; payout fails closed without one (ADR-026). | **OPEN** — hard blocker |
| Provider abstraction | Separate `IPayoutProviderPort` with `pay`/`getStatus` and a five-valued outcome (ADR-022). Not written yet. | **DECIDED** |
| Idempotency | Two keys: `SETTLEMENT-<settlementId>` for the ledger, `PAYOUT-<attemptId>` for the provider call; attempt row committed before the call (ADR-024). | **DECIDED** |
| Ledger timing | Generate and approve post nothing; only a confirmed payout posts, exactly once; the payable is consumed by the debit itself (ADR-025). | **DECIDED** |
| Ambiguous provider result | Never `FAILED`; stays `PROCESSING`; resolved by status query, callback or a human. No automatic repair. | **DECIDED** (callback auth, partial payout, recall OPEN) |
| Settlement freezing | Snapshotted at generation and already immutable; late postings flow into the next period, never into an approved statement. | **DECIDED** (negative carry-forward OPEN) |
| Reconciliation | Five facts kept distinct; six new read-only anomaly kinds. | **DECIDED**, unbuilt |
| API / RBAC | §9.6's `approve|pay` naming kept; one new permission required; nothing granted. | **DECIDED**, unbuilt |
| Provider prerequisites | Twelve-item list; items 1–7 are blocking. Telebirr stays fail-closed. | **OPEN** — external |

---

## Open Questions for Product/Compliance
1. **Payment providers at launch** — confirm Telebirr + which bank(s)/card processor + diaspora gateway; each needs adapter + credentials.
2. **Auth+capture vs immediate capture** — do the chosen local providers support holds (authorize) or only immediate charge? (affects §6 per-method behavior).
3. **Platform fee model** — flat %, per-category %, or fixed+% ; who pays delivery fee accounting-wise (customer vs split)?
4. **Settlement cadence** — daily/weekly/monthly payouts; minimum payout threshold; payout rails (bank transfer/Telebirr B2B).
5. **COD reconciliation** — how is driver-collected cash reconciled and settled (ties to Delivery Module 9)?
6. **Refund destination default** — wallet (faster) vs original method; regulatory constraints on refunds. *(Still open. Both destinations are implemented; which one a caller should default to is a product/compliance choice — see ADR-017.)*
7. **Is the platform commission refundable at all on a *partial* refund?** §11.4 says it is reversed proportionally, and ADR-016 makes that rule deterministic. Whether finance instead wants the platform to keep its commission — always, or only on customer-fault cancellations — is a product decision that would supersede ADR-016.
8. **Cancellation policy content (BRULE-20).** Module 06 states *when* a customer may cancel but not the policy's terms (cut-off, cancellation fee, partial charge). Refund eligibility for cancellations cannot be fully specified until that exists (ADR-017).
9. ~~**Who funds a coupon discount?**~~ **Answered (2026-09-11): the platform.** A coupon is a platform-funded promotion — pharmacy proceeds are never reduced by it, and the discount is booked as a `PROMOTION_EXPENSE` ledger leg so the capture still balances (ADR-019, §8, §11.3). Implemented; the integration gate this question previously imposed on checkout is lifted. What remains is downstream and unbuilt: settlement must read `PROVIDER_PAYABLE` (which already excludes promotional spend) and must never net `PROMOTION_EXPENSE` into payable or revenue, and reporting must show revenue and promotional spend as separate lines.
10. **Can a settlement statement be withdrawn?** A statement is immutable by construction (no update, no delete), so a wrongly-cut `DRAFT` is currently permanent. Whether withdrawal is expressed as a `CANCELLED` terminal state or by superseding the statement with an adjustment has different audit consequences and is a finance decision (§15.2, ADR-023).
11. **Payout rail contract.** Blocking, and distinct from Open Question 1 — disbursement is a different product from collection, often with different credentials and a different API even at the same provider. §15.12 lists the twelve items required; items 1–7 block implementation. The fail-closed stance stands until they exist.
12. **Payout destination and beneficiary verification.** No payout destination exists in the schema (§15.4, ADR-026). Which module owns the beneficiary, the field set per rail, who verifies it and against what evidence, the change-control rules for a beneficiary change, and whether ADR-009's envelope encryption applies to account identifiers — all unanswered, all blocking.
13. **Maker/checker separation for payouts.** Must the approver differ from the generator, and the payer from the approver? Does `SUPER_ADMIN`'s wildcard bypass the rule or must it be enforced where a wildcard cannot reach? Is there an amount threshold requiring a second approver? The repository can express all of this (Module 16's `ApprovalRequest` already carries `requestedByUserId` and `decidedByUserId`); the rule itself is a compliance decision (§15.3).
14. **Negative carry-forward.** When a period's refund clawback exceeds the next period's payable, the provider owes the platform. Carried forward, invoiced, or recovered another way? Commercial decision (§15.9).

---

**End of Module 7 design.** Awaiting your approval to proceed. Recommended next module: **Delivery Management & Tracking** — delivery job creation on order-ready, driver assignment/accept, real-time WebSocket tracking, proof of delivery, and driver earnings (FR-DEL, BRULE-27..30), including COD cash reconciliation that ties back to this module.
