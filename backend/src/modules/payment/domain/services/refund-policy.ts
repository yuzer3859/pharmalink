import { PaymentProps } from '../entities/payment.entity';
import { PaymentStatus, RefundDestination, RefundType } from '../enums';
import { PaymentErrors } from '../errors';
import { Money } from '../value-objects/money.vo';

/**
 * The payment statuses money can be returned from (§6, BRULE-24).
 *
 * `CAPTURED` is §6's own table verbatim — it is the only state with `refund (full)` and
 * `refund (partial)` edges. `PARTIALLY_REFUNDED` is included because §6 annotates that state with
 * "remaining capturable tracked": a partially refunded payment by definition still has a
 * refundable remainder, and a design that tracks a remainder it then refuses to refund would be
 * self-contradictory. Every other state is excluded, and none of the exclusions is a judgement
 * call: `INITIATED`/`AUTHORIZED`/`EXPIRED` never collected money (an authorization is a hold —
 * the instrument for releasing it is `void`, not `refund`), `FAILED`/`VOIDED` are terminal
 * no-money states, `REFUNDED` has nothing left, and `SETTLED` is discussed below.
 */
const REFUNDABLE_STATUSES: ReadonlySet<PaymentStatus> = new Set([
  PaymentStatus.CAPTURED,
  PaymentStatus.PARTIALLY_REFUNDED,
]);

/** What `RefundPolicy` decided about a request that passed every check. */
export interface RefundClassification {
  amount: Money;
  /** `FULL` iff this refund exhausts the remaining refundable amount (see `classify`). */
  type: RefundType;
  /** Already-refunded total *before* this refund, in the payment's currency. */
  alreadyRefunded: Money;
  /** Refundable amount before this refund: captured − alreadyRefunded. */
  remainingBefore: Money;
  /** Refundable amount after this refund. Zero means the payment is now fully refunded. */
  remainingAfter: Money;
}

/**
 * Refund eligibility (§3.2 F-RFD-01/02/03, §5.3, §11.4, BRULE-24).
 *
 * Pure and I/O-free: it is handed the payment, the already-refunded total and the request, and it
 * decides. The *atomicity* of that decision is not its job — reading the total and inserting the
 * refund inside one `Serializable` transaction is what makes two concurrent refunds unable to
 * observe the same remainder, and that lives in `RefundPaymentCommand`. A policy that returned
 * the right answer against a stale total would still over-refund, so the two halves are
 * deliberately separate and both are required.
 *
 * ## What this policy deliberately does NOT check: order state
 *
 * §3.2 F-RFD-03 says "refund eligibility checks tied to order state (BRULE-24)", and BRULE-24
 * reads: *"Refunds are issued only for eligible cancellations, failed deliveries, or verified
 * disputes."* Each of those three is **specified in the architecture, and owned by another
 * module** — none of them is a Module 07 concept and none is implemented yet:
 *
 *  - an *eligible* cancellation is BRULE-20 plus Module 06's cancellation policy. Module 06's
 *    `OrderStatus` has `CANCELLED`, but nothing in it distinguishes an eligible cancellation from
 *    an ineligible one — that is the policy's job, and the policy's terms are still undefined.
 *  - a *failed delivery* is Module 08's `DeliveryStatus.FAILED` (module-08 §F-STS-01), reaching
 *    Module 07 via Module 06 (`DeliveryFailed` is catalogued as a Module 06 consumer).
 *  - a *verified dispute* is Module 16's `DisputeCase` resolved with a refund `ResolutionAction`
 *    (module-16 §7, BRULE-50) — which arrives as a manual refund by an admin actor.
 *
 * **ADR-017 settles this, and the answer is that no order-status whitelist belongs here at all.**
 * Eligibility is gated in two places, each owned by the module that can actually decide it: this
 * module gates on *payment state* (§6 — `CAPTURED` or `PARTIALLY_REFUNDED`, with a pre-capture
 * cancellation compensated by `VOID` instead), while whether a given cancellation, delivery failure
 * or dispute *deserves* a refund is decided by Module 06 (BRULE-20), Module 08 or Module 16 and
 * reaches this command as a `SYSTEM` refund from that module's saga or a `MANUAL` one. Copying
 * BRULE-20's policy into Module 07 would create a second cancellation policy free to drift from
 * the first — the ownership failure ADR-002 exists to prevent.
 *
 * The control on the human path is the design's own: §3.2 F-RFD-03 and §9.3 require manual/admin
 * refunds to carry `finance:refund:any` **plus an audit trail**, and `RefundPaymentCommand`
 * enforces exactly that — a named, permissioned, audited person decides, which is what "verified
 * dispute" means in practice. So this method is complete as it stands; the automated triggers need
 * their own modules, not a whitelist here.
 *
 * ## Why `SETTLED` is not refundable here
 *
 * §6 defines no transition out of `SETTLED`, and refunding money that has already been paid out
 * to a pharmacy is a *clawback* against a future settlement (§3.5 F-STL-03's "adjustments (refunds
 * clawback)") — a settlement-module operation with its own accounting, not a payment refund. It is
 * excluded rather than guessed at.
 */
export const RefundPolicy = {
  /**
   * The amount still refundable: `captured − alreadyRefunded` (§5.3, BRULE-24). Never negative —
   * a negative remainder would mean the over-refund guard had already been breached, so it is
   * raised as a defect rather than clamped to zero and hidden.
   */
  remainingRefundable(payment: PaymentProps, alreadyRefunded: Money): Money {
    const captured = Money.of(payment.amount, payment.currency);
    captured.assertSameCurrency(alreadyRefunded);
    const remaining = captured.subtract(alreadyRefunded);
    if (remaining.isNegative) {
      throw PaymentErrors.ledgerUnbalanced({
        debit: alreadyRefunded.amountMinor,
        credit: captured.amountMinor,
        currency: captured.currency.code,
      });
    }
    return remaining;
  },

  /**
   * Validates a refund request and classifies it, or throws.
   *
   * Order of checks is deliberate: the cheap structural ones (amount, currency, destination)
   * first, then payment eligibility, then BRULE-24's invariant last — so a caller who sent a
   * malformed amount is told that, rather than being told the amount exceeds a remainder that
   * was never the real problem.
   */
  classify(input: {
    payment: PaymentProps;
    /** Sum of every refund that counts against the total (`RefundStatusPolicy`). */
    alreadyRefunded: Money;
    /** `null` means "refund everything still refundable" (§9.3 — "amount omitted = full"). */
    requestedAmount: Money | null;
    destination: RefundDestination;
  }): RefundClassification {
    const { payment, alreadyRefunded, destination } = input;

    if (!Object.values(RefundDestination).includes(destination)) {
      throw PaymentErrors.validation('Unknown refund destination.', {
        field: 'destination',
        value: destination,
      });
    }

    // Eligibility before arithmetic: a payment that never collected money has no remainder worth
    // computing, and reporting "amount exceeds 0" would misdescribe why the refund was refused.
    if (!REFUNDABLE_STATUSES.has(payment.status)) {
      throw PaymentErrors.refundNotEligible(payment.id, payment.status);
    }

    const remainingBefore = RefundPolicy.remainingRefundable(payment, alreadyRefunded);

    // "amount omitted = full" (§9.3): the full refund is the whole remainder, not the whole
    // original capture — refunding the capture again after a partial refund would over-refund.
    const amount = input.requestedAmount ?? remainingBefore;

    // A currency mismatch is never a conversion: §5.3 forbids implicit FX, and a refund is settled
    // in the currency the payment was captured in (BRULE-22 — always ETB).
    amount.assertSameCurrency(remainingBefore);
    amount.assertPersistable('amount');

    if (!amount.isPositive) {
      throw PaymentErrors.validation('A refund amount must be a positive integer (minor units).', {
        field: 'amount',
        value: amount.amountMinor,
      });
    }

    // BRULE-24's invariant, and §9's own `REFUND_EXCEEDS_CAPTURED`.
    if (amount.isGreaterThan(remainingBefore)) {
      throw PaymentErrors.refundExceedsCaptured({
        paymentId: payment.id,
        requested: amount.amountMinor,
        captured: payment.amount,
        alreadyRefunded: alreadyRefunded.amountMinor,
        remaining: remainingBefore.amountMinor,
        currency: payment.currency,
      });
    }

    const remainingAfter = remainingBefore.subtract(amount);

    return {
      amount,
      // §7's `type` column: `FULL` when the refund exhausts what is left to refund, `PARTIAL`
      // otherwise. Classified against the *remainder*, not the original capture, so the refund
      // that closes out a partially-refunded payment is correctly a `FULL` one.
      type: remainingAfter.isZero ? RefundType.FULL : RefundType.PARTIAL,
      alreadyRefunded,
      remainingBefore,
      remainingAfter,
    };
  },

  /** Whether money can be returned from this payment's current state at all. */
  isRefundableStatus(status: PaymentStatus): boolean {
    return REFUNDABLE_STATUSES.has(status);
  },

  refundableStatuses(): PaymentStatus[] {
    return [...REFUNDABLE_STATUSES];
  },
};
