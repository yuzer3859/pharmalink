# Prepaid checkout: the saga's payment steps (Work 95)

Before this Work, checkout supported only cash on delivery: every order went straight to `PAID`
and no order waited for a payment (Phase 1 audit gaps G1 and G8). Work 95 adds saga steps 7 and 8
of module-06 §6 for a gateway payment. Cash on delivery is unchanged.

## Request

`POST /checkout` takes an optional `payment`:

```json
{ "addressId": "...", "idempotencyKey": "...", "payment": { "method": "TELEBIRR", "token": "...", "returnUrl": "https://..." } }
```

| Field | Rule |
|---|---|
| `method` | `TELEBIRR`, `CARD`, `BANK_TRANSFER` or `CROSS_BORDER` (gateway methods only) |
| `token` | Optional, at most 512 characters. The gateway's opaque token, never card data (BRULE-26). |
| `returnUrl` | Optional `http(s)` URL. With it, the payment is a redirect flow. |

Without `payment`, the order is cash on delivery, exactly as before. The response gains
`payment: { paymentId, status, providerRedirect }`, or `null` for cash on delivery.

## The saga

1. Steps 1–6 are unchanged: idempotency, cart, address, fresh prices, Rx gate, matching and
   reservation, coupon, delivery fee and totals.
2. A prepaid order's reservations stay `HELD`, under Module 04's TTL. It is committed as
   `PENDING_PAYMENT` with `isCod = false`. Only `order.placed` is written; `order.paid` waits for
   the payment.
3. **Step 7:** Module 07 authorizes through `PAYMENT_AUTHORIZATION_PORT`, outside every
   transaction (ADR-014). The idempotency key is `checkout-<orderId>`, so a checkout replay never
   opens a second payment.
4. **Step 8** depends on the outcome:

| Outcome | What happens |
|---|---|
| `AUTHORIZED` | `PrepaidPaymentService.onAuthorized` confirms the reservations. In one Serializable transaction it then moves `PENDING_PAYMENT → PAID` (history event `PAYMENT_AUTHORIZED`, actor `SYSTEM`), records `orders.paymentId`, audits `ORDER_PAID` and writes `order.paid` carrying the payment. |
| Declined (`402 PAYMENT_AUTH_FAILED`) | **Compensation.** The order is cancelled through `OrderCancellationWorkflow`, which releases the stock, cancels the order with reason `payment-failed` and reverses the coupon. The workflow is durable and its reconciler resumes it after a crash. The decline is returned with `orderId` added to `error.details`. |
| `INITIATED` with a redirect | The order waits. The gateway's webhook makes Module 07 emit `payment.authorized` or `payment.failed`, and `PaymentOutcomeHandler` applies it the same way. |
| Unknown (gateway unreachable) | The error is returned and the order waits. A checkout replay with the same key re-drives the same authorization. |

Every outcome is idempotent. The event for an outcome the request already applied changes
nothing.

## Edge cases

- **The stock hold expired before the payment was authorized.** The authorization is voided and
  the order cancelled (`reservation-expired-before-payment`). Money is never held for an order
  that cannot be filled.
- **A late authorization for an order no longer waiting** (cancelled or timed out). It is voided.
- **Never paid.** `UnpaidOrderReconciler` runs every 5 minutes. It cancels prepaid orders still
  `PENDING_PAYMENT` once the window has passed: the reservation TTL plus 5 minutes, so 20 minutes
  by default. The reason is `payment-not-completed-in-time`, with the same compensation.
- **A customer cancels a paid prepaid order.** The cancellation workflow now also voids the order's
  authorization, before reversing the coupon. Voiding is idempotent in Module 07. Refunding a
  captured payment comes with capture in Work 96. Until then a prepaid payment is never captured,
  so a void always applies.
- **Pharmacies** see a prepaid order only once its payment is recorded. One awaiting payment, or
  cancelled because it was never paid, is not listed. Accepting already required `PAID`.

## Decisions (recommended option)

- **In-request authorization.** The design's orchestrated saga calls Module 07 in-process. The
  customer does not call `POST /payments/authorize` separately; that route stays for other
  clients.
- **Compensation reuses the durable cancellation workflow,** rather than adding a second
  cancellation path. Its history entry names the customer as initiator, with the reason recording
  why.
- **The cart is converted when the order is placed,** as for cash on delivery. After a decline the
  app offers to rebuild the cart from the cancelled order's lines (Work 100).
- **No migration.** `orders.paymentId` and `orders.isCod` already existed.
