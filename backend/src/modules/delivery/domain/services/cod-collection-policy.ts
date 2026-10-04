import { CodCollectionProps, varianceOf } from '../entities/cod-collection.entity';
import { CodRemittanceProps } from '../entities/cod-remittance.entity';
import { CodCollectionStatus, CodReconciliationOutcome, DeliveryJobStatus } from '../enums';

/** How a declared amount compares with what the job said was due. */
export enum CodAmountOutcome {
  /** The customer paid exactly the order total. */
  Exact = 'EXACT',
  /** Less than the order total. */
  Under = 'UNDER',
  /** More than the order total. */
  Over = 'OVER',
}

/** How a remitted amount compares with what the driver declared collecting. */
export enum CodRemittanceOutcome {
  /** The channel handed over exactly what it declared taking. */
  Exact = 'EXACT',
  /** Less than it declared — the case a remittance step exists to catch. */
  Short = 'SHORT',
  /** More than it declared. Rarer, and just as much a discrepancy. */
  Over = 'OVER',
}

/** The rules an operator may set for COD, resolved from configuration by the application layer. */
export interface CodPolicySettings {
  /**
   * Whether a collection whose amount differs from the order total is refused outright.
   *
   * `false` — the shipped default — records the discrepancy instead. See
   * `CodCollectionPolicy.isAmountAcceptable` for why refusing by default would be inventing a
   * commercial rule.
   */
  requireExactAmount: boolean;
  /**
   * Whether a COD delivery must have a recorded collection before the job may reach `COMPLETED`.
   *
   * `false` by default, and the reason is specific to this platform rather than a general
   * preference: **every Slice-1 order is COD** (`CheckoutCommand` writes `isCod: true`
   * unconditionally), no driver application posts a collection yet, and switching this on by
   * default would strand every delivery on the platform at `DELIVERED` on the day it shipped.
   */
  requireCollectionForCompletion: boolean;
}

/**
 * `CodCollectionPolicy` (§3.5 F-COD-01, BR-DEL-10) — when a COD collection may be recorded, and
 * what a declared amount means.
 *
 * Pure: no I/O, no configuration reads, no clock. It is handed a status, an amount pair and a set
 * of rules, and it answers. The same discipline `ProofOfDeliveryPolicy` and `DriverEarningPolicy`
 * already apply, and for the same reason — a rule that can be evaluated without a container is a
 * rule that can be reasoned about.
 *
 * ## What it deliberately does not decide
 *
 * It does not decide whether the delivery may proceed, whether the driver is owed anything, who
 * may confirm a remittance, or what the platform does about a shortfall. A shortfall is a commercial and possibly a disciplinary
 * question — recover from the driver, absorb it, chase the customer — and none of those has been
 * decided anywhere in this repository. The policy's job is to make the discrepancy **visible and
 * un-loseable**; deciding what happens next is a product decision, and inventing one here would
 * bury it in a delivery module.
 */
export const CodCollectionPolicy = {
  /**
   * The one stage at which a driver may record a collection: **`ARRIVED_DROPOFF`**.
   *
   * Identical to `ProofOfDeliveryPolicy.isCaptureAllowedIn`, and identical on purpose. Money
   * changes hands at the door, at the same moment the goods do; earlier the driver has not reached
   * the customer, and later the delivery has already been posted on the strength of whatever was
   * true at the time. A collection recorded after `DELIVERED` would be cash attached to a finished
   * delivery at an unknown moment, which is the same "masquerade as contemporaneous" problem the
   * proof-of-delivery work refused to allow for evidence — and cash is the more tempting one to
   * backdate.
   *
   * The consequence is deliberate: a driver must post `/arrived-dropoff` first. That status is
   * their claim to be at the address, and both the money and the evidence are anchored to it.
   *
   * It also produces the brief's expected sequence without any orchestration needing to enforce it:
   * `ARRIVED_DROPOFF → record COD → capture PoD → DELIVERED`.
   */
  isRecordingAllowedIn(status: DeliveryJobStatus): boolean {
    return status === DeliveryJobStatus.ARRIVED_DROPOFF;
  },

  /** How a declared amount compares with the job's frozen expectation. */
  classifyAmount(expectedAmount: number, collectedAmount: number): CodAmountOutcome {
    if (collectedAmount === expectedAmount) {
      return CodAmountOutcome.Exact;
    }
    return collectedAmount < expectedAmount ? CodAmountOutcome.Under : CodAmountOutcome.Over;
  },

  /**
   * Whether a declared amount may be recorded at all.
   *
   * **By default: yes, whatever it is.** A driver standing at a door with less money than the order
   * came to has a real situation, and the platform's choices are to record what happened or to
   * refuse and leave no trace of it. Refusing by default would be inventing an exact-payment rule
   * that no approved document states, and it would push a driver towards typing the expected figure
   * instead of the true one — turning a recorded shortfall into an unrecorded one. §7's "safe
   * default is to record the discrepancy explicitly".
   *
   * An operator who decides COD must be exact sets `requireExactAmount`, and the refusal then
   * happens at the application boundary with nothing written.
   *
   * Either way the discrepancy is never smoothed over: the row keeps both numbers, and
   * `isReconcilable` refuses to treat the collection as settled cash.
   */
  isAmountAcceptable(
    expectedAmount: number,
    collectedAmount: number,
    settings: CodPolicySettings,
  ): boolean {
    if (!settings.requireExactAmount) {
      return true;
    }
    return this.classifyAmount(expectedAmount, collectedAmount) === CodAmountOutcome.Exact;
  },

  /**
   * Whether this collection could be reconciled as-is.
   *
   * `false` whenever the amounts disagree, **regardless of configuration** — this is not a tunable.
   * Reconciliation means the platform has satisfied itself that the money it received matches the
   * money it was owed, and a row where those differ has not met that bar by definition. Letting a
   * discrepancy through would be the one thing §7 names outright: creating a fake successful
   * payment so that the paperwork closes.
   *
   * Nothing in this work *performs* reconciliation. This is the predicate the work that does will
   * ask, placed here so that the rule is stated once and cannot be re-derived differently later.
   */
  isReconcilable(collection: CodCollectionProps): boolean {
    return varianceOf(collection) === 0;
  },

  /**
   * The one status from which a remittance may be confirmed: **`COLLECTED`**.
   *
   * Not `REMITTED`, because a second confirmation of the same handover would be the platform
   * recording that it received the same cash twice — and the idempotent path answers that case
   * with the row it already has rather than a new one. Not `RECONCILED`, because a remittance
   * arriving after the check that was supposed to cover it would make the check meaningless.
   *
   * There is no "remit before collect" branch to write. A collection row is what a remittance
   * points at, so a delivery with no collection has nothing to remit and is refused by the lookup
   * before this rule is ever consulted.
   */
  isRemittanceAllowedIn(status: CodCollectionStatus): boolean {
    return status === CodCollectionStatus.COLLECTED;
  },

  /**
   * The one status from which a reconciliation may be recorded: **`REMITTED`**.
   *
   * This is the rule that makes §5's lifecycle a guarantee rather than a diagram.
   * `COLLECTED → RECONCILED` is unreachable — not discouraged, unreachable — because it would mean
   * PharmaLink certifying money it has not been handed, on the strength of the declaration of the
   * channel that is holding it. The whole separation of duties collapses if that shortcut exists,
   * and no permission check can substitute for its absence: an authorized finance officer
   * reconciling an unremitted collection is exactly the mistake this refuses.
   */
  isReconciliationAllowedIn(status: CodCollectionStatus): boolean {
    return status === CodCollectionStatus.REMITTED;
  },

  /** How what arrived compares with what the driver declared taking. */
  classifyRemittance(collectedAmount: number, remittedAmount: number): CodRemittanceOutcome {
    if (remittedAmount === collectedAmount) {
      return CodRemittanceOutcome.Exact;
    }
    return remittedAmount < collectedAmount
      ? CodRemittanceOutcome.Short
      : CodRemittanceOutcome.Over;
  },

  /**
   * The platform's finding when it checks a remittance against the collection it covers.
   *
   * **`ACCEPTED` requires both gaps to be zero** — what the customer paid must match what the order
   * came to, *and* what arrived must match what the driver declared. A collection that was already
   * short cannot be reconciled clean by a channel that faithfully remitted the short amount: the
   * platform is still missing money, and an `ACCEPTED` row would say otherwise. Anything else is
   * `DISCREPANCY`, which is a recorded finding rather than a refusal.
   *
   * Currency is part of the check. Two amounts in different currencies are not comparable at all,
   * and this module holds no exchange rate and must not appear to: a mismatch is a discrepancy the
   * operator has to look at, never something silently converted.
   *
   * There is no configuration here, and there deliberately never will be. `isReconcilable` above
   * makes the same point for the collection alone: whether the books balanced is arithmetic, not
   * policy, and an operator who could tune it could tune away the only signal this step produces.
   */
  classifyReconciliation(
    collection: CodCollectionProps,
    remittance: CodRemittanceProps,
  ): CodReconciliationOutcome {
    const currencyMatches = collection.currency === remittance.currency;
    const collectionClean = varianceOf(collection) === 0;
    const remittanceClean =
      this.classifyRemittance(collection.collectedAmount, remittance.remittedAmount) ===
      CodRemittanceOutcome.Exact;

    return currencyMatches && collectionClean && remittanceClean
      ? CodReconciliationOutcome.ACCEPTED
      : CodReconciliationOutcome.DISCREPANCY;
  },
};
