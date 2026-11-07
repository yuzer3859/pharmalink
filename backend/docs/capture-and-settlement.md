# Capture at fulfilment and settled payments (Work 96)

This Work closes Phase 1 audit gaps G2 and G3 (`architecture/phase-1-status.md`):
- **G2:** nothing ever captured a prepaid payment, so no `CAPTURE` posting reached the ledger and
  nothing accrued for settlement.
- **G3:** no payment ever reached `SETTLED`.

## Capture at fulfilment (module-07 §11.3)

When the pharmacy marks a prepaid order **ready**, Module 06's `OrderReadyCaptureHandler` reacts to
the order's own `order.ready` event. It calls Module 07's `capture` through
`PAYMENT_AUTHORIZATION_PORT`. The capture:
- moves the payment `AUTHORIZED → CAPTURED`;
- posts the ledger's `CAPTURE-<paymentId>` transaction: gateway clearing against the provider
  payable and platform revenue, plus promotion expense for a platform-funded coupon;
- emits `payment.captured`.

Module 06 then records `orders.paymentCapturedAt` (new nullable column, additive migration
`20261108000000_module06_order_payment_captured_at`).

- **Retries.** `PaymentCaptureReconciler` runs every 5 minutes. It sweeps prepaid orders at
  `READY`, `DISPATCHED`, `DELIVERED` or `COMPLETED` that have a payment but no recorded capture, for
  example when the gateway was unreachable or the event was never delivered.
- **Idempotency.** Module 07 answers an already-captured payment as a replay, and the column is
  written once. A payment that cannot be captured (already voided, say) fails each run and is
  logged with its order and payment ids, for finance.
- **Timing.** Not before ready: a customer may still cancel a paid order up to `ACCEPTED`, and then
  the authorization is voided (Work 95), with no capture to refund.
- **COD orders** have no payment and are never captured.

## Settled payments (module-07 §6, BRULE-23)

When a settlement statement is paid (`ExecutePayoutCommand`, `PROCESSING → PAID`), every payment
whose capture the statement pays out moves `CAPTURED → SETTLED`. These are the statement's payout
lines with source `payment`. The move happens in the same transaction as the statement and its
`SETTLEMENT` posting. The `SETTLEMENT_PAID` audit entry records `settledPaymentCount`.

A payment already `PARTIALLY_REFUNDED` keeps that status. `PARTIALLY_REFUNDED → SETTLED` is still
not modelled (ADR-018's open question), and its refund is the more informative fact. The payout
lines still record that it was paid out.

## Refunds after settlement

Before this Work, `SETTLED` was terminal and could not be refunded. Making payments settle without
changing that would have stopped refunds of any order already paid out to its pharmacy. So:

- `SETTLED → REFUNDED` and `SETTLED → PARTIALLY_REFUNDED` are legal (`PaymentStatusPolicy`), and
  `SETTLED` is refundable (`RefundPolicy`).
- The refund's ledger posting reverses the provider payable, exactly as for a captured payment. The
  provider's next settlement statement nets it as `refundClawback`, so the money is recovered from
  the pharmacy (§3.5 F-STL-03). Tested: after the payout, a partial refund produces a next statement
  with a positive clawback and a negative net amount.

## Decisions (recommended option)

- **Capture at ready, as the design says,** not at delivery. A delivery that then fails is a
  refund.
- **Through Module 06's own event plus a sweep,** rather than inside `MarkReadyCommand`. Marking an
  order ready never waits on, or fails because of, a gateway.
- **Settle in the payout transaction,** so a paid statement and its settled payments can never
  disagree.
