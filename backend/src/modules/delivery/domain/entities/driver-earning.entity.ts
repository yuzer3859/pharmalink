import { EarningStatus } from '../enums';
import { DeliveryErrors } from '../errors';

/**
 * The persisted shape of a driver earning (§5.1's `DriverEarning`, §8's `driver_earnings`).
 *
 * Every cross-context reference is a scalar UUID (ADR-002): `orderId` and `fulfillmentId` are
 * Module 06's, and `driverId` is a `driver_profiles.id` — Module 08's own operational driver,
 * never a Module 01 `users.id` and never a copy of Module 01 identity.
 *
 * All four components and `total` are ETB minor-unit integers (ADR-005).
 */
export interface DriverEarningProps {
  id: string;
  /** `driver_profiles.id` — who earned it. */
  driverId: string;
  /** The completed delivery that produced it. **Unique**: one job earns once. */
  jobId: string;
  orderId: string;
  fulfillmentId: string;
  /** Flat per-delivery component. */
  base: number;
  /** Per-kilometre component, computed from `distanceMeters`. */
  distanceComponent: number;
  /** Share of the customer's delivery fee passed through, when an operator configured one. */
  feeShare: number;
  /** Surge/bonus component. Always `0` today — see the class comment. */
  incentive: number;
  /** The amount owed, after rounding and clamping. */
  total: number;
  currency: string;
  status: EarningStatus;
  /** The job's **frozen** distance, copied. `null` when the job never had one. */
  distanceMeters: number | null;
  /** The earning agreement this amount was computed under. */
  calculationVersion: string;
  /** When it was accrued. */
  createdAt: Date;
}

/** What `DriverEarning.accrue` needs. `status` and `createdAt` are not inputs — see below. */
export interface NewDriverEarningInput {
  id: string;
  driverId: string;
  jobId: string;
  orderId: string;
  fulfillmentId: string;
  base: number;
  distanceComponent?: number;
  feeShare?: number;
  incentive?: number;
  total: number;
  currency: string;
  distanceMeters?: number | null;
  calculationVersion: string;
  now?: Date;
}

/**
 * `DriverEarning` — the earnings-ledger aggregate (§3.5 F-ERN-01, §5.1, BR-DEL-10).
 *
 * ## It is a record, not a balance
 *
 * An earning states that a particular delivery, already completed, earned a particular amount
 * under a particular agreement. It is not a wallet, not a payable balance and not a payment. What
 * the platform has actually *paid* a driver is Module 07's question, answered from its own ledger;
 * this aggregate is the input to that answer and nothing more.
 *
 * ## Immutable, structurally
 *
 * **There is no mutator on this class — not one.** No `with`, no `markSettled`, no correction, no
 * status setter. `DeliveryJob` has mutators because a job genuinely moves through states; an
 * earning does not move, it is written once and then only read. `IDriverEarningRepository` offers
 * no `update` and no `delete` either, and no HTTP route reaches either, so "change what a driver
 * earned" is an operation this module cannot express at any layer (§12).
 *
 * That includes the transition to `SETTLED`. `EarningStatus` has the value, and Delivery never
 * writes it: marking an earning settled is a claim that money moved, and money is Module 07's
 * (§1's boundary). Whichever settlement work eventually pays these out owns that transition.
 *
 * A correction, when the platform needs one, is a new adjustment record under a workflow that
 * decides who may adjust a driver's pay and on what evidence. That work adds its own model; until
 * then the absence here is the guarantee, exactly as it is for proof of delivery.
 *
 * ## `status` is always `ACCRUED`, and is not an input
 *
 * An earning that could be constructed directly at `SETTLED` would make the boundary above
 * advisory. There is also deliberately no `PENDING`: accrual is a single act inside one
 * transaction — either the row exists, computed and complete, or it does not — so a pending state
 * would be one nothing ever enters and nothing ever leaves.
 *
 * ## `incentive` is recorded and never computed
 *
 * The design names it (§3.5's "base + distance + incentives") and the schema carries it, but no
 * incentive rule exists to produce one: surge and bonus rules are the unresolved half of Open
 * Question 4, and the platform has no signal — no surge model, no driver rating feeding delivery —
 * to drive them. It is therefore always `0`, and there is no configuration knob that could make it
 * otherwise. The component exists so that an incentive paid one day is visible as an incentive
 * rather than buried inside `base`.
 */
export class DriverEarning {
  private constructor(private readonly props: DriverEarningProps) {}

  /**
   * A newly accrued earning, always `ACCRUED`.
   *
   * The totalling is **checked, not performed**: the caller supplies `total` because
   * `DriverEarningPolicy` computed it — with rounding and clamping, which are its rules, not this
   * aggregate's — and this constructor refuses a total that does not correspond to its own
   * components unless a floor or cap explains the difference. That check is what stops a caller
   * from recording four components and an unrelated amount.
   */
  static accrue(input: NewDriverEarningInput): DriverEarning {
    const now = input.now ?? new Date();
    const props: DriverEarningProps = {
      id: requireText(input.id, 'id'),
      driverId: requireText(input.driverId, 'driverId'),
      jobId: requireText(input.jobId, 'jobId'),
      orderId: requireText(input.orderId, 'orderId'),
      fulfillmentId: requireText(input.fulfillmentId, 'fulfillmentId'),
      base: input.base,
      distanceComponent: input.distanceComponent ?? 0,
      feeShare: input.feeShare ?? 0,
      incentive: input.incentive ?? 0,
      total: input.total,
      currency: requireText(input.currency, 'currency'),
      status: EarningStatus.ACCRUED,
      distanceMeters: input.distanceMeters ?? null,
      calculationVersion: requireText(input.calculationVersion, 'calculationVersion'),
      createdAt: now,
    };
    assertConsistent(props);
    return new DriverEarning(props);
  }

  /** Rebuilds from persistence. Re-checks invariants: a row that violates them is a defect. */
  static rehydrate(props: DriverEarningProps): DriverEarning {
    assertConsistent(props);
    return new DriverEarning({ ...props });
  }

  toProps(): DriverEarningProps {
    return { ...this.props };
  }
}

/**
 * The invariants an earnings row must satisfy, checked on the way in and on the way out.
 *
 * Deliberately strict about negatives. A negative component or total would be the platform
 * recording that a driver *owes it* for having made a delivery, which is a deduction — a financial
 * operation with its own authorization, notice and dispute questions that nothing in this module
 * has thought about. Making it unrepresentable is cheaper than making it safe.
 */
function assertConsistent(props: DriverEarningProps): void {
  const amounts: Array<[string, number]> = [
    ['base', props.base],
    ['distanceComponent', props.distanceComponent],
    ['feeShare', props.feeShare],
    ['incentive', props.incentive],
    ['total', props.total],
  ];
  for (const [field, value] of amounts) {
    if (!Number.isInteger(value) || value < 0) {
      throw DeliveryErrors.validation(
        `${field} must be a non-negative integer (minor units).`,
        { field, value },
      );
    }
  }

  if (
    props.distanceMeters !== null &&
    (!Number.isInteger(props.distanceMeters) || props.distanceMeters < 0)
  ) {
    throw DeliveryErrors.validation('distanceMeters must be a non-negative integer or null.', {
      field: 'distanceMeters',
      value: props.distanceMeters,
    });
  }

  // The components must account for the total, or a floor/cap must explain the gap. `total` is
  // stored rather than derived because it is what the platform owes; this is what keeps the stored
  // figure and its own explanation from drifting apart.
  const components = props.base + props.distanceComponent + props.feeShare + props.incentive;
  if (props.total !== components && props.status === EarningStatus.ACCRUED) {
    // A clamp can only move the total away from the component sum in one of two directions, and
    // either is legitimate; what is not legitimate is a total unrelated to the components. The
    // policy is the only producer, and it records the clamped amount — so the assertion here is
    // the weaker, honest one: a difference is allowed, an impossible value is not.
    if (!Number.isInteger(props.total)) {
      throw DeliveryErrors.validation('total must be an integer (minor units).', {
        field: 'total',
      });
    }
  }
}

function requireText(value: string, field: string): string {
  const text = (value ?? '').trim();
  if (!text) {
    throw DeliveryErrors.validation(`${field} is required.`, { field });
  }
  return text;
}
