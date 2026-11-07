import { PaymentStatus } from '../enums';
import { PaymentErrors } from '../errors';

/**
 * Pure state machine for `Payment.status` (`architecture/module-07-payment-wallet.md` §6). It is
 * the design's transition table verbatim — no transition is added beyond it:
 *
 *   INITIATED  → AUTHORIZED   provider authorization succeeded (sync or via webhook); Orders may
 *                             now confirm the order (BRULE-17).
 *   INITIATED  → FAILED       authorization failed/timed out; Orders compensates.
 *   INITIATED  → EXPIRED      the attempt was never completed by the customer.
 *   AUTHORIZED → CAPTURED     order fulfilled; money collected, provider payable accrues.
 *   AUTHORIZED → VOIDED       order cancelled before capture; hold released, no charge.
 *   AUTHORIZED → EXPIRED      the authorization hold lapsed before capture.
 *   CAPTURED   → SETTLED      included in a provider payout batch (BRULE-23).
 *   CAPTURED   → REFUNDED / PARTIALLY_REFUNDED  (BRULE-24).
 *
 *   PARTIALLY_REFUNDED → REFUNDED  a further refund exhausts the remainder (ADR-018).
 *
 * That last edge is the one addition §6's original table did not carry. It is here on the strength
 * of ADR-018 and §6's corrected table, not on convention: §6 annotates `PARTIALLY_REFUNDED` with
 * "remaining capturable tracked", so the state is defined by *having* a remainder and cannot be
 * the right state once the remainder is zero. Without it, two payments repaid in full would hold
 * different statuses purely because one took two requests and the other one — making `status` a
 * record of request history rather than of the payment's state.
 *
 * It fires only when nothing remains refundable, and `RefundPaymentCommand` decides that from the
 * *derived* remainder (captured − refunds actually completed), never from a refund's own
 * `FULL`/`PARTIAL` classification: a payment can reach zero through any sequence of partials.
 *
 * `SETTLED → REFUNDED / PARTIALLY_REFUNDED` (Work 96): a payment paid out to a pharmacy can still
 * be refunded to the customer. The refund's ledger posting reverses the provider payable, and the
 * next settlement run nets it as that provider's `refundClawback` (§3.5 F-STL-03), so the money is
 * recovered from the pharmacy rather than lost. Before Work 96 no payment ever reached `SETTLED`.
 *
 * Everything else is terminal. `PARTIALLY_REFUNDED → SETTLED` is still absent (ADR-018's open
 * question): a partially refunded payment keeps that status when its statement is paid.
 */
const LEGAL_TRANSITIONS: Record<PaymentStatus, ReadonlySet<PaymentStatus>> = {
  [PaymentStatus.INITIATED]: new Set([
    PaymentStatus.AUTHORIZED,
    PaymentStatus.FAILED,
    PaymentStatus.EXPIRED,
  ]),
  [PaymentStatus.AUTHORIZED]: new Set([
    PaymentStatus.CAPTURED,
    PaymentStatus.VOIDED,
    PaymentStatus.EXPIRED,
  ]),
  [PaymentStatus.CAPTURED]: new Set([
    PaymentStatus.SETTLED,
    PaymentStatus.REFUNDED,
    PaymentStatus.PARTIALLY_REFUNDED,
  ]),
  [PaymentStatus.PARTIALLY_REFUNDED]: new Set([PaymentStatus.REFUNDED]),
  // Work 96: a settled payment can still be refunded. The refund's ledger posting reverses the
  // provider payable, and the next settlement run nets it as `refundClawback` (§3.5 F-STL-03).
  [PaymentStatus.SETTLED]: new Set([PaymentStatus.REFUNDED, PaymentStatus.PARTIALLY_REFUNDED]),
  [PaymentStatus.FAILED]: new Set(),
  [PaymentStatus.VOIDED]: new Set(),
  [PaymentStatus.REFUNDED]: new Set(),
  [PaymentStatus.EXPIRED]: new Set(),
};

export const PaymentStatusPolicy = {
  isLegalTransition(from: PaymentStatus, to: PaymentStatus): boolean {
    return LEGAL_TRANSITIONS[from]?.has(to) ?? false;
  },

  assertValidTransition(from: PaymentStatus, to: PaymentStatus): void {
    if (!PaymentStatusPolicy.isLegalTransition(from, to)) {
      throw PaymentErrors.invalidPaymentStateTransition(from, to);
    }
  },

  /** No legal outgoing transition exists — the payment's lifecycle has ended. */
  isTerminal(status: PaymentStatus): boolean {
    return LEGAL_TRANSITIONS[status]?.size === 0;
  },

  legalTransitionsFrom(status: PaymentStatus): PaymentStatus[] {
    return [...(LEGAL_TRANSITIONS[status] ?? [])];
  },
};
