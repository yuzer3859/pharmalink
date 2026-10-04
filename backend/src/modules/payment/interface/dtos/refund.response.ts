import { RefundPaymentResult } from '../../application/commands/refund-payment.command';
import {
  PaymentRefundsView,
  RefundView,
} from '../../application/queries/list-payment-refunds.query';
import { PaymentStatus, RefundDestination, RefundStatus, RefundType } from '../../domain/enums';

/**
 * `POST /payments/{id}/refunds` → the refund that was created, and what it did to the payment.
 *
 * An explicit allow-list, not a pass-through of `RefundPaymentResult`, for the same reason
 * `toCaptureResponse` is one: a later field added to the command's result must not silently widen
 * what HTTP exposes.
 *
 * **`ledgerReference` is deliberately dropped.** It is the internal `REFUND-<refundId>` handle on
 * the double-entry posting, and §11's rule is that ledger internals do not cross the HTTP
 * boundary — the capture route omits its own for the same reason. ADR-016's split is dropped with
 * it: the `feeClawback` and `providerClawback` legs are how the platform's books are kept, not
 * something the customer or the finance officer requesting the refund transacts against. Both are
 * recorded in the audit trail (§13), which is read under `audit:read:any`.
 *
 * `providerRef` *is* returned. It is the reference a customer quotes to support and a gateway
 * shows on a statement, it is not a credential, and `PaymentView`/`RefundView` already publish it.
 * It is `null` while a refund is `PENDING` and the gateway has given us nothing to quote.
 */
export interface RefundPaymentResponse {
  refundId: string;
  paymentId: string;
  amount: number;
  currency: string;
  type: RefundType;
  destination: RefundDestination;
  /** `COMPLETED`, or `PENDING` when the gateway's answer was ambiguous. Never inferred. */
  status: RefundStatus;
  /** The payment's status *after* this refund — `PARTIALLY_REFUNDED` or `REFUNDED` (ADR-018). */
  paymentStatus: PaymentStatus;
  providerRef: string | null;
  /** What may still be refunded on this payment, so a client need not compute it. */
  remainingRefundable: number;
  createdAt: Date;
  completedAt: Date | null;
  /** `true` when an already-committed refund was returned rather than a new one performed. */
  replay: boolean;
}

export function toRefundResponse(result: RefundPaymentResult): RefundPaymentResponse {
  return {
    refundId: result.refundId,
    paymentId: result.paymentId,
    amount: result.amount,
    currency: result.currency,
    type: result.type,
    destination: result.destination,
    status: result.status,
    paymentStatus: result.paymentStatus,
    providerRef: result.providerRef,
    remainingRefundable: result.remainingRefundable,
    createdAt: result.createdAt,
    completedAt: result.completedAt,
    replay: result.replay,
    // `ledgerReference` is deliberately omitted — see the interface doc.
  };
}

/**
 * `GET /payments/{id}/refunds` → exactly what `ListPaymentRefundsQuery` produces.
 *
 * There is no mapper here on purpose. That query is already the safe projection — it omits
 * `approvedBy`, `idempotencyKey`, the payment's `providerToken` and every ledger internal — and
 * re-listing its fields in a second interface would create a second refund representation to keep
 * in step with the first. The aliases exist so the controller's signature names the HTTP contract
 * rather than reaching into the application layer's types at every call site.
 */
export type RefundListItemResponse = RefundView;
export type PaymentRefundsResponse = PaymentRefundsView;
