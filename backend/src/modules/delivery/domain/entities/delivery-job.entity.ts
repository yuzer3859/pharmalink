import { DeliveryJobStatus } from '../enums';
import { DeliveryErrors } from '../errors';
import { DeliveryStatusPolicy } from '../services/delivery-status-policy';
import { GeoPoint } from '../value-objects/geo-point.vo';

/**
 * One line of the job's item summary (§3.2 F-JOB-02's "items summary").
 *
 * **A snapshot, and a deliberately thin one.** It carries what a driver needs to check a handover
 * — what, and how many — and nothing a driver has no business seeing. There is no price, no
 * prescription reference, no diagnosis and no customer health information: the delivery context
 * is the least privileged place this data passes through, and a field absent from the type cannot
 * leak from it. Cold-chain handling is a job-level flag (BRULE-30), not a per-line one, because
 * the whole job routes through one temperature regime.
 */
export interface DeliveryItemSummary {
  /** Module 03 `catalogProductId` — a scalar cross-context reference (ADR-002). */
  catalogProductId: string;
  /** The name as it read when the job was created. Snapshot: a later rename must not rewrite it. */
  name: string;
  quantity: number;
}

/**
 * The persisted shape of a delivery job (§5.1, §8's `delivery_jobs`).
 *
 * Every cross-context reference is a scalar UUID with no Prisma relation (ADR-002): `orderId` and
 * `fulfillmentId` are Module 06's, `pharmacyId`/`branchId` are Module 04's. Module 08 owns none of
 * that data and never joins to it — it snapshots what it needs at creation and refers to the rest
 * by id.
 *
 * The pickup and dropoff *snapshots* are the point of that discipline. A customer who edits their
 * address, or a pharmacy that moves a branch, must not retroactively change where a completed
 * delivery went; the job records where it was actually going.
 */
export interface DeliveryJobProps {
  id: string;
  /** Module 06 `Order.id`. Label and correlation key — Module 08 never reads or writes order state. */
  orderId: string;
  /**
   * Module 06 `Fulfillment.id`. **The job's natural identity**: §5.3's "job per fulfillment"
   * rationale — an order can split across pharmacies, so one pickup location is one job is one
   * driver route.
   */
  fulfillmentId: string;
  /** Module 04 `Pharmacy.id` and `Branch.id` — where the goods are collected. */
  pharmacyId: string;
  branchId: string;
  pickupPoint: GeoPoint | null;
  /** Free-form address snapshot as it read at creation. */
  pickupAddress: string | null;
  dropoffPoint: GeoPoint | null;
  dropoffAddress: string | null;
  items: DeliveryItemSummary[];
  /** BRULE-30 — surfaced to the driver; handling attestation is a later work. */
  isColdChain: boolean;
  /** BRULE-27's COD flag. `codAmount` is integer minor units (ADR-005), and only ever ETB here. */
  isCod: boolean;
  codAmount: number | null;
  /**
   * **The delivery fee the customer was charged** — a copy of `Order.deliveryFee`, in ETB minor
   * units (ADR-005), frozen onto the job when it was cut.
   *
   * Not recalculated here, and that distinction is the point. Module 06 froze this amount inside
   * its checkout transaction and the customer has already agreed to it; a job that re-ran the rate
   * card at creation time would produce a second money fact for the same delivery, and the two
   * would part company the first time an operator adjusted a rate between checkout and dispatch.
   * `Order.deliveryFee` stays authoritative and this is a read-only echo of it, exactly as
   * `codAmount` echoes `Order.grandTotal`.
   *
   * It is here because the delivery context needs to answer "what was this delivery worth?"
   * without reaching into Module 06 on every read — the operational question behind driver
   * earnings (Work 10), which must not have to reverse-engineer a historical fee from current
   * configuration. What it must never become is a *second* amount anybody charges from.
   */
  deliveryFee: number;
  /**
   * The routed distance from pickup to dropoff at creation time, in metres, or `null` when it
   * could not be established.
   *
   * Delivery's own operational fact rather than a money one: it is what the job was dispatched
   * against and what a later earning or performance question is measured over. `null` is an honest
   * answer — a branch or an address stored without coordinates, or a routing provider that could
   * not answer — and never a fabricated straight line.
   */
  distanceMeters: number | null;
  status: DeliveryJobStatus;
  /** `driver_profiles.id` — Module 08's own operational driver, not a Module 01 user id. */
  assignedDriverId: string | null;
  pickedUpAt: Date | null;
  deliveredAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** What `DeliveryJob.create` needs. Everything else is derived or defaulted. */
export interface NewDeliveryJobInput {
  id: string;
  orderId: string;
  fulfillmentId: string;
  pharmacyId: string;
  branchId: string;
  pickupPoint?: GeoPoint | null;
  pickupAddress?: string | null;
  dropoffPoint?: GeoPoint | null;
  dropoffAddress?: string | null;
  items?: DeliveryItemSummary[];
  isColdChain?: boolean;
  isCod?: boolean;
  codAmount?: number | null;
  /** The charged fee, copied from Module 06. Defaults to `0` — the platform's current rate card. */
  deliveryFee?: number;
  distanceMeters?: number | null;
  now?: Date;
}

/** The information a transition carries with it, beyond the target status. */
export interface DeliveryTransitionContext {
  /**
   * The driver taking the job on. **Required** on the transition into `ASSIGNED`, and refused on
   * any other — an assignment is the only moment a job acquires a driver.
   */
  assignedDriverId?: string | null;
  now?: Date;
}

/**
 * `DeliveryJob` — the Module 08 aggregate root (§5.1).
 *
 * ## What it owns, and what it must never own
 *
 * It owns the **delivery job lifecycle**: status, assignment, and the timestamps that record when
 * the physical events happened. §1's boundary is enforced here by omission, which is the only way
 * a boundary survives:
 *
 * - **No order state.** There is no `orderStatus` field and no method that sets one. Advancing an
 *   order is Module 06's, reached later by an event, never by this aggregate reaching across.
 * - **No money it computes.** `codAmount` is recorded because the driver must know what to
 *   collect, and `deliveryFee` because the delivery context has to be able to say what a completed
 *   delivery was worth. Both are **copies of amounts Module 06 froze** — this aggregate computes
 *   neither, has no setter for either, and there is no method here that prices anything. The
 *   calculation lives in `DeliveryFeePolicy`, the charge lives on `Order`, and accruing an earning
 *   or reconciling cash is Module 07's ledger and a later work.
 * - **No driver identity.** `assignedDriverId` is a `driver_profiles.id` — operational state.
 *   Verification and onboarding (BRULE-09) stay Module 01's, and this aggregate cannot check them
 *   because it must not: it would need to read another context's data to do so.
 *
 * ## Immutability of the record
 *
 * Every mutator returns a **new** `DeliveryJob` rather than mutating in place, so a rejected
 * transition leaves the caller's instance untouched and a half-applied state is unrepresentable.
 * `DeliveryStatusHistory` (§8) is the append-only trail of these transitions; writing it is the
 * application layer's job, which is why `transitionTo` reports both ends of the move.
 */
export class DeliveryJob {
  private constructor(private readonly props: DeliveryJobProps) {}

  /**
   * A new job, always at `CREATED` (§8's column default).
   *
   * The status is not an input. A job that could be constructed directly at `DELIVERED` would
   * make the state machine advisory, and the one guarantee this aggregate offers is that every
   * job reached its status through legal transitions.
   *
   * BRULE-27 — "a job is created only when its fulfillment is `READY`" — is deliberately **not**
   * checked here. It is a cross-context precondition about Module 06 state, and a domain entity
   * that read another bounded context to validate itself would be the exact coupling ADR-002
   * forbids. The creating command asserts it through `IOrdersPort`.
   */
  static create(input: NewDeliveryJobInput): DeliveryJob {
    const now = input.now ?? new Date();
    const props: DeliveryJobProps = {
      id: requireText(input.id, 'id'),
      orderId: requireText(input.orderId, 'orderId'),
      fulfillmentId: requireText(input.fulfillmentId, 'fulfillmentId'),
      pharmacyId: requireText(input.pharmacyId, 'pharmacyId'),
      branchId: requireText(input.branchId, 'branchId'),
      pickupPoint: input.pickupPoint ?? null,
      pickupAddress: trimOrNull(input.pickupAddress),
      dropoffPoint: input.dropoffPoint ?? null,
      dropoffAddress: trimOrNull(input.dropoffAddress),
      items: normalizeItems(input.items ?? []),
      isColdChain: input.isColdChain ?? false,
      isCod: input.isCod ?? false,
      codAmount: input.codAmount ?? null,
      deliveryFee: input.deliveryFee ?? 0,
      distanceMeters: input.distanceMeters ?? null,
      status: DeliveryJobStatus.CREATED,
      assignedDriverId: null,
      pickedUpAt: null,
      deliveredAt: null,
      createdAt: now,
      updatedAt: now,
    };
    assertConsistent(props);
    return new DeliveryJob(props);
  }

  /** Rebuilds a job from persistence. Re-checks invariants: a row that violates them is a defect. */
  static rehydrate(props: DeliveryJobProps): DeliveryJob {
    assertConsistent(props);
    return new DeliveryJob({ ...props, items: normalizeItems(props.items) });
  }

  /**
   * Applies a status transition, or refuses it.
   *
   * The timestamps that mark physical events are set **by the transition that causes them**, never
   * by a separate call: `pickedUpAt` on entering `PICKED_UP`, `deliveredAt` on entering
   * `DELIVERED`. A job cannot therefore be `PICKED_UP` without a pickup time, nor carry a pickup
   * time it never reached — the two are written together or not at all.
   *
   * A transition is idempotent-friendly but not idempotent: re-sending the *same* status is
   * refused here, because the state machine has no self-loops. §12's "duplicate `/picked-up`
   * returns current state, not error" is an **application-layer** concern — the command compares
   * the current status before calling this, which keeps "is this a retry?" (needs request context)
   * out of a pure domain rule.
   */
  transitionTo(to: DeliveryJobStatus, context: DeliveryTransitionContext = {}): DeliveryJob {
    DeliveryStatusPolicy.assertValidTransition(this.props.status, to);
    const now = context.now ?? new Date();

    if (to === DeliveryJobStatus.ASSIGNED) {
      const driverId = requireText(context.assignedDriverId ?? '', 'assignedDriverId');
      return this.with({ status: to, assignedDriverId: driverId, updatedAt: now });
    }
    if (context.assignedDriverId !== undefined && context.assignedDriverId !== null) {
      throw DeliveryErrors.validation(
        'assignedDriverId may only be supplied when assigning a job.',
        { field: 'assignedDriverId', to },
      );
    }

    if (to === DeliveryJobStatus.REASSIGNING) {
      // The slot is released the moment the job goes back into dispatch: leaving the previous
      // driver attached would keep their concurrent-job count consumed (BRULE-28) by work they no
      // longer hold, and would let a stale id reach a later notification.
      return this.with({ status: to, assignedDriverId: null, updatedAt: now });
    }
    if (to === DeliveryJobStatus.PICKED_UP) {
      return this.with({ status: to, pickedUpAt: now, updatedAt: now });
    }
    if (to === DeliveryJobStatus.DELIVERED) {
      return this.with({ status: to, deliveredAt: now, updatedAt: now });
    }
    return this.with({ status: to, updatedAt: now });
  }

  get id(): string {
    return this.props.id;
  }
  get status(): DeliveryJobStatus {
    return this.props.status;
  }
  get assignedDriverId(): string | null {
    return this.props.assignedDriverId;
  }
  get isTerminal(): boolean {
    return DeliveryStatusPolicy.isTerminal(this.props.status);
  }
  get isCancellable(): boolean {
    return DeliveryStatusPolicy.isCancellable(this.props.status);
  }

  /** A defensive copy — the aggregate's state can only change through its own methods. */
  toProps(): DeliveryJobProps {
    return { ...this.props, items: this.props.items.map((item) => ({ ...item })) };
  }

  private with(patch: Partial<DeliveryJobProps>): DeliveryJob {
    const next = { ...this.props, ...patch };
    assertConsistent(next);
    return new DeliveryJob(next);
  }
}

/**
 * The invariants every job must satisfy, checked on creation, on every transition and on
 * rehydration — so a persisted row that has drifted is caught on read rather than propagated.
 */
function assertConsistent(props: DeliveryJobProps): void {
  // COD (§8's `is_cod`/`cod_amount`). The flag and the amount are one fact recorded twice, and
  // either half alone is a defect with a cash consequence: a COD job with no amount sends a driver
  // to collect an unknown sum, and an amount on a non-COD job invites them to collect one that was
  // already paid online.
  if (props.isCod) {
    if (props.codAmount === null || !Number.isInteger(props.codAmount) || props.codAmount <= 0) {
      throw DeliveryErrors.validation(
        'A COD job requires a positive integer codAmount in minor units.',
        { field: 'codAmount', value: props.codAmount },
      );
    }
  } else if (props.codAmount !== null) {
    throw DeliveryErrors.validation('codAmount must be absent when the job is not COD.', {
      field: 'codAmount',
      value: props.codAmount,
    });
  }

  // Assignment. A job in a driver-carrying state must name its driver, and one that has not been
  // assigned must not — an `assignedDriverId` on an unassigned job would make a dispatch look
  // already taken.
  const needsDriver = DeliveryStatusPolicy.requiresAssignedDriver(props.status);
  if (needsDriver && !props.assignedDriverId) {
    throw DeliveryErrors.validation(`A ${props.status} job must have an assigned driver.`, {
      field: 'assignedDriverId',
      status: props.status,
    });
  }
  if (
    !needsDriver &&
    props.assignedDriverId &&
    props.status !== DeliveryJobStatus.CANCELLED &&
    props.status !== DeliveryJobStatus.FAILED
  ) {
    // CANCELLED and FAILED keep whichever driver they had: the trail of who was carrying the job
    // when it ended is exactly what a dispute needs.
    throw DeliveryErrors.validation(
      `A ${props.status} job must not have an assigned driver.`,
      { field: 'assignedDriverId', status: props.status },
    );
  }

  // Physical-event timestamps. Presence is tied to having reached the state, and order is checked
  // because a delivery that precedes its own pickup is a clock or a code defect, not a delivery.
  if (props.pickedUpAt && props.deliveredAt && props.deliveredAt < props.pickedUpAt) {
    throw DeliveryErrors.validation('deliveredAt cannot precede pickedUpAt.', {
      field: 'deliveredAt',
    });
  }
  if (props.deliveredAt && !props.pickedUpAt) {
    throw DeliveryErrors.validation('A delivered job must have a pickedUpAt.', {
      field: 'pickedUpAt',
    });
  }

  for (const item of props.items) {
    if (!Number.isInteger(item.quantity) || item.quantity <= 0) {
      throw DeliveryErrors.validation('Each item quantity must be a positive integer.', {
        field: 'items.quantity',
        catalogProductId: item.catalogProductId,
      });
    }
  }
}

function normalizeItems(items: DeliveryItemSummary[]): DeliveryItemSummary[] {
  return items.map((item) => ({
    catalogProductId: requireText(item.catalogProductId, 'items.catalogProductId'),
    name: requireText(item.name, 'items.name'),
    quantity: item.quantity,
  }));
}

function requireText(value: string, field: string): string {
  const text = (value ?? '').trim();
  if (!text) {
    throw DeliveryErrors.validation(`${field} is required.`, { field });
  }
  return text;
}

function trimOrNull(value?: string | null): string | null {
  const text = (value ?? '').trim();
  return text.length > 0 ? text : null;
}
