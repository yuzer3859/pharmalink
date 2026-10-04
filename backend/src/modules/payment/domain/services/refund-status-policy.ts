import { RefundStatus } from '../enums';
import { PaymentErrors } from '../errors';

/**
 * State machine for `refunds.status` (`architecture/module-07-payment-wallet.md` §7's `refunds`
 * model, §11.4's flow).
 *
 * ## Why this table looks smaller than the enum
 *
 * Unlike §6's payment table, the design gives **no** refund transition table — it gives a status
 * column with four values and one sequence flow. So this policy models exactly the transitions
 * §11.4 actually performs and nothing else:
 *
 *   PENDING → COMPLETED  the refund's money movement is confirmed: for `ORIGINAL`, the gateway
 *                        confirmed it; for `WALLET`, the ledger credit is the confirmation.
 *   PENDING → FAILED     the gateway positively declined the refund. The amount goes back into
 *                        the refundable pool, because no money moved.
 *
 * `PENDING` is the state a refund is *created* in, before any external call — it is the persisted
 * intent that makes the provider step recoverable (see `RefundPaymentCommand`).
 *
 * **`APPROVED` is deliberately unreachable.** §7 lists it as a possible value, but nothing in the
 * design describes a two-step approval workflow: §3.2 F-RFD-03 and §9.3 require an *audited
 * approval for manual refunds*, which this module implements as `finance:refund:any` plus the
 * `approvedBy` actor plus the audit entry — a permission check and a recorded actor, not a
 * separate persisted stage a refund waits in. Inventing a queue-and-approve lifecycle here would
 * be adding a business process nobody specified, so `APPROVED` has no incoming and no outgoing
 * edge until a task defines what enters and leaves it.
 *
 * `COMPLETED` and `FAILED` are terminal. A refund is never reopened: a further refund is a new
 * `Refund` row against the same payment, exactly as a further ledger correction is a new posting.
 */
const LEGAL_TRANSITIONS: Record<RefundStatus, ReadonlySet<RefundStatus>> = {
  [RefundStatus.PENDING]: new Set([RefundStatus.COMPLETED, RefundStatus.FAILED]),
  // See the class doc: no path creates an APPROVED refund, and none leaves one.
  [RefundStatus.APPROVED]: new Set(),
  [RefundStatus.COMPLETED]: new Set(),
  [RefundStatus.FAILED]: new Set(),
};

export const RefundStatusPolicy = {
  isLegalTransition(from: RefundStatus, to: RefundStatus): boolean {
    return LEGAL_TRANSITIONS[from]?.has(to) ?? false;
  },

  assertValidTransition(from: RefundStatus, to: RefundStatus): void {
    if (!RefundStatusPolicy.isLegalTransition(from, to)) {
      throw PaymentErrors.invalidRefundStateTransition(from, to);
    }
  },

  /** No legal outgoing transition exists — the refund's lifecycle has ended. */
  isTerminal(status: RefundStatus): boolean {
    return LEGAL_TRANSITIONS[status]?.size === 0;
  },

  legalTransitionsFrom(status: RefundStatus): RefundStatus[] {
    return [...(LEGAL_TRANSITIONS[status] ?? [])];
  },

  /**
   * Whether a refund in this status has moved (or is still expected to move) money, and therefore
   * counts against BRULE-24's "already refunded" total.
   *
   * `FAILED` does not count: the gateway declined and nothing left the platform, so the amount is
   * refundable again. `PENDING` **does** count, and that is the conservative choice on purpose —
   * an in-flight refund may well succeed, and letting a second request spend the same money while
   * the first is outstanding is exactly the over-refund BRULE-24 forbids.
   */
  countsAgainstRefundedTotal(status: RefundStatus): boolean {
    return status !== RefundStatus.FAILED;
  },
};

/** The statuses that count against the refunded total, for repository-level aggregation. */
export const REFUNDED_TOTAL_STATUSES: readonly RefundStatus[] = Object.values(RefundStatus).filter(
  (status) => RefundStatusPolicy.countsAgainstRefundedTotal(status),
);
