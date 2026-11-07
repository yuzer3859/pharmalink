# The test payment gateway (Work 94)

`MockPaymentProvider` (`modules/payment/infrastructure/providers/mock-payment-provider.adapter.ts`)
is the in-process stand-in for a real gateway. Development, the test suites and the staging stack
use it. It makes no network calls and moves no money.

## Never in production

`isAvailable()` is false when `NODE_ENV=production`. The provider registry routes only to
available gateways, so in production:
- A new gateway payment (Telebirr, card, bank transfer, cross-border) that no real gateway claims
  is refused with `UNSUPPORTED_PAYMENT_METHOD` (a validation error naming provider `none`). Nothing
  is ever "authorized" against money nobody holds.
- A payment recorded with provider `mock` cannot be captured, voided or refunded
  (`DEPENDENCY_UNAVAILABLE`, reason `not_available`). Only the gateway holding an authorization may
  act on it.

Before this Work, the mock was bound in every environment. A production deployment without a real
gateway would have confirmed unpaid orders (audit gap G10 in `architecture/phase-1-status.md`).

Cash on delivery and wallet payments do not use a gateway and are unaffected.

## Test decline

Outside production, authorizing with the token `test-decline` declines deterministically:

```http
POST /payments/authorize
Idempotency-Key: <8-128 characters>

{ "orderId": "...", "method": "TELEBIRR", "token": "test-decline" }
```

- **Response:** `402 PAYMENT_AUTH_FAILED`, "Declined by the test gateway."
- **Payment:** `FAILED`, with that reason.
- **Audit:** `PAYMENT_AUTH_FAILED`, with `failureCode: test_decline`.
- **Event:** `payment.failed` on the outbox.

It lets a staging walk and the e2e suites drive the checkout saga's compensation through the real
wiring (Work 95). It is a fixed public string, not a secret.

Any other token authorizes at once. A `returnUrl` still produces the redirect flow (`INITIATED`,
then a webhook).
