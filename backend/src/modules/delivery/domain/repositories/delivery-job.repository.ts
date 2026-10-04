import { DeliveryJobProps } from '../entities/delivery-job.entity';
import { DeliveryActorType, DeliveryJobStatus } from '../enums';

export const DELIVERY_JOB_REPOSITORY = Symbol('DELIVERY_JOB_REPOSITORY');

/**
 * A status transition, as the repository persists it.
 *
 * The state machine lives in the domain — this port writes whichever state `DeliveryJob` has
 * already proven legal, exactly as `IRefundRepository.updateState` and `IPaymentRepository`'s
 * equivalent do for Module 07. The timestamps travel **with** the transition that sets them, so a
 * pickup and its time can never be written apart from one another.
 */
/**
 * What the row must still look like for a state update to apply — the *compare* half of the
 * compare-and-set.
 *
 * `status` alone was enough while only dispatch and accept moved a job. The status workflow adds a
 * second thing that must not have changed underneath a request: **who is carrying it**. A driver
 * posting `/picked-up` has already been checked for ownership, but a reassignment can commit
 * between that check and this write, and a released driver must not be able to advance a job that
 * now belongs to somebody else.
 *
 * Including the driver in the `WHERE` clause makes that a database guarantee rather than a
 * consequence of `Serializable` isolation catching the read-write dependency. The isolation level
 * would very likely catch it — but an authorization rule should not rest on "very likely", and a
 * guard that is visible in the query is one a reader can check.
 *
 * `assignedDriverId` omitted means "do not compare the driver", which is what a platform-side
 * transition wants: a cancellation or a completion is not made on behalf of a driver.
 */
export interface DeliveryJobStateExpectation {
  status: DeliveryJobStatus;
  /** The `driver_profiles.id` the row must still name. Omit to leave the driver uncompared. */
  assignedDriverId?: string | null;
}

export interface DeliveryJobStateUpdate {
  status: DeliveryJobStatus;
  assignedDriverId?: string | null;
  pickedUpAt?: Date | null;
  deliveredAt?: Date | null;
}

/**
 * One immutable transition record (§8's `delivery_status_history`).
 *
 * `actorType` distinguishes a driver's own post from a dispatcher's or an operator's, which is
 * what §13's trail is read for. The coordinates are the driver's position *at the moment of the
 * transition* where it is known — a picked-up that happened nowhere near the pharmacy is the kind
 * of thing a dispute turns on.
 */
export interface DeliveryStatusHistoryEntry {
  jobId: string;
  fromStatus: DeliveryJobStatus | null;
  toStatus: DeliveryJobStatus;
  actorType: DeliveryActorType;
  /** The driver profile id, the operator's user id, or `null` for an automated transition. */
  actorId?: string | null;
  reason?: string | null;
  lat?: number | null;
  lng?: number | null;
}

/** A history row as it reads back. `createdAt` is the transition's own timestamp. */
export interface DeliveryStatusHistoryRecord extends DeliveryStatusHistoryEntry {
  id: string;
  createdAt: Date;
}

export interface ListDeliveryJobsCriteria {
  /**
   * The providers whose jobs may be returned. `undefined` is unrestricted and `[]` matches
   * nothing — the two are not interchangeable, the same discipline
   * `ListSettlementsCriteria.pharmacyIds` records.
   */
  pharmacyIds?: string[];
  assignedDriverId?: string;
  status?: DeliveryJobStatus;
  /**
   * Several statuses at once, for the driver's own list — "everything still on my plate" is a set,
   * not one value, and `status` cannot express it.
   *
   * Combined with `status` by intersection when both are given, which is what lets a caller narrow
   * a fixed allow-list down to one of its members without being able to step outside it. `[]`
   * matches nothing, exactly as `pharmacyIds` does; `undefined` leaves the status unconstrained.
   */
  statuses?: DeliveryJobStatus[];
  page: number;
  size: number;
}

export interface DeliveryJobPage {
  items: DeliveryJobProps[];
  total: number;
}

/**
 * Persistence port for the `DeliveryJob` aggregate (§5.1, §8's `delivery_jobs`).
 *
 * Domain-facing snapshots only — no Prisma type crosses this boundary (ADR-002), exactly like
 * every Module 04/05/06/07 repository.
 *
 * ## Scope
 *
 * The reads and writes the job lifecycle itself needs, plus the two counts BRULE-28 rests on. It
 * deliberately carries **no offer surface** — candidate selection and offers are
 * `IDriverProfileRepository.findDispatchCandidates` and `IJobOfferRepository`, because an offer is
 * its own aggregate with its own lifecycle and folding it in here would make a job repository the
 * place two unrelated state machines were persisted.
 *
 * There is deliberately **no delete**. A delivery job is the record of a physical movement of
 * medicines; a job that should not have existed is `CANCELLED`, which is a fact, rather than
 * removed, which erases one.
 */
export interface IDeliveryJobRepository {
  /**
   * The job for a Module 06 fulfillment, if one exists.
   *
   * This is the idempotency lookup for job creation: §5.3's "job per fulfillment" makes
   * `fulfillmentId` the job's natural key, so a repeated `OrderReady` event must find the existing
   * job rather than dispatch a second driver to the same pickup. The creating command enforces
   * that; the unique index that would back it belongs with that work, since this foundation
   * writes no jobs.
   */
  findByFulfillmentId(fulfillmentId: string, tx?: unknown): Promise<DeliveryJobProps | null>;

  findById(id: string, tx?: unknown): Promise<DeliveryJobProps | null>;

  /**
   * Every job cut for a Module 06 order — one per fulfillment (§5.3), so a split order has
   * several.
   *
   * Exists because Module 06's `OrderCancelled` carries an `orderId` and nothing else, and
   * cancelling *the order* has to reach *every* job it produced. Returning a list rather than one
   * job is the whole point: a single-job assumption would silently leave the second pharmacy's
   * driver on the road after a split order was cancelled.
   */
  findByOrderId(orderId: string, tx?: unknown): Promise<DeliveryJobProps[]>;

  /**
   * A job's transitions, oldest first (§8's `delivery_status_history`).
   *
   * The read side of `appendStatusHistory`. This is where the intermediate physical timestamps
   * live — arrival at pickup, the start of the route, arrival at the doorstep, completion — which
   * is why they are not also columns on `delivery_jobs`: one fact, one home. Ordered by the index
   * `(jobId, createdAt)`, with `id` breaking the tie so two transitions written in the same
   * millisecond still read back in a stable order.
   */
  listStatusHistory(jobId: string, tx?: unknown): Promise<DeliveryStatusHistoryRecord[]>;

  list(criteria: ListDeliveryJobsCriteria, tx?: unknown): Promise<DeliveryJobPage>;

  /**
   * How many jobs this driver is currently holding — **the concurrent-job limit's count**
   * (BRULE-28, §3.1 F-DRV-04).
   *
   * Counted from `delivery_jobs` over `DriverAvailabilityPolicy.ACTIVE_JOB_STATUSES`, never read
   * from a stored counter. The Phase-0 schema had `driver_profiles.active_job_count` for this and
   * the driver-operational-profile work drops it: a counter guarding a limit has to be adjusted
   * on every one of twelve job transitions, one missed decrement pins a driver at their limit
   * forever, one missed increment lets them exceed it, and neither is visible until a driver is
   * carrying more medicines than policy allows. `00-shared-conventions.md` §9 and ADR-006 state
   * the project's position on exactly this shape — derived, "never authoritative mutable
   * counters".
   *
   * The cost is a count over one driver's open jobs — a handful of rows, on the composite index
   * `(assignedDriverId, status)` added with this method.
   *
   * This is the capability the dispatch work's accept path (§11.2) consumes; nothing refuses an
   * assignment yet, because nothing assigns yet.
   */
  countActiveJobs(driverProfileId: string, tx?: unknown): Promise<number>;

  /**
   * The same count for many drivers at once, as a map keyed by `driver_profiles.id`.
   *
   * One grouped query rather than one per candidate. Dispatch ranks every online driver, and
   * asking `countActiveJobs` per driver would make the candidate scan N+1 round trips on the
   * critical path of every delivery the platform makes.
   *
   * Drivers with no active jobs are **absent from the map**, not present with `0` — that is what
   * `GROUP BY` returns, and inventing the zeroes here would mean building a second collection to
   * hold them. Callers read it with `?? 0`.
   */
  countActiveJobsByDriver(
    driverProfileIds: readonly string[],
    tx?: unknown,
  ): Promise<Map<string, number>>;

  /**
   * Appends one row to `delivery_status_history` (§8, §13's "every status transition (with geo)").
   *
   * On the repository rather than in a service of its own because it is persistence, and beside
   * `updateState` because the two must always be written together: a status change with no
   * history row leaves the trail with a gap exactly where somebody will later ask what happened.
   * The table is append-only — there is no update and no delete for it anywhere in this module.
   */
  appendStatusHistory(entry: DeliveryStatusHistoryEntry, tx?: unknown): Promise<void>;

  /** Inserts a job the domain has already validated (`DeliveryJob.create(...).toProps()`). */
  create(job: DeliveryJobProps, tx?: unknown): Promise<DeliveryJobProps>;

  /**
   * Persists an already-legal transition.
   *
   * `expected` is the caller's read of the job, and the implementation must apply the update only
   * while the row still matches it — a compare-and-set, returning `null` when it does not.
   * Two drivers' apps, or an app and a sweeper, can post concurrently, and a last-write-wins
   * update would let a stale `ARRIVED_PICKUP` overwrite a committed `PICKED_UP`. Returning `null`
   * rather than throwing lets the caller decide whether it is a retry (§12's idempotent status
   * posts) or a genuine conflict.
   */
  updateState(
    id: string,
    expected: DeliveryJobStateExpectation,
    update: DeliveryJobStateUpdate,
    tx?: unknown,
  ): Promise<DeliveryJobProps | null>;

  /**
   * Locks and returns one job that wants a driver and has no live offer, or `null`.
   *
   * The recovery scan behind `DispatchRecoverySweeper`. "Wants a driver" is `statuses` — `CREATED`,
   * `OFFERED` and `REASSIGNING`, the same set dispatch accepts — and "has no live offer" is the
   * `NOT EXISTS` against `job_offers`, which is what distinguishes a job nobody is working on from
   * one a driver is currently being asked about.
   *
   * `quietSince` excludes jobs touched more recently than that instant, so a job dispatch is
   * actively working on is left alone and only genuinely stalled work is picked up. That is the
   * difference between recovery and interference.
   *
   * `FOR UPDATE SKIP LOCKED` as the transaction's first statement, for the reason
   * `IJobOfferRepository.lockNextExpired` gives.
   */
  lockNextStranded(
    statuses: readonly DeliveryJobStatus[],
    quietSince: Date,
    excludeIds: readonly string[],
    tx: unknown,
  ): Promise<DeliveryJobProps | null>;

  /**
   * Locks and returns one pre-pickup job whose assigned driver is no longer working, or `null`.
   *
   * §11.5's "driver goes offline/unavailable before pickup", discovered rather than waited for.
   * "No longer working" is read from `driver_profiles` at the moment of the scan — the driver is
   * not `ONLINE`/`BUSY`, or has no open shift — because that is the same condition
   * `DriverAvailabilityPolicy.isConsistent` names, and duplicating it as a stored flag on the job
   * would be the mirrored-authorization mistake `IIdentityPort` documents.
   *
   * `statuses` is supplied by the caller and must contain only pre-pickup states; the state machine
   * refuses `PICKED_UP -> REASSIGNING` regardless, so a mistake here cannot move goods off a
   * driver who is already carrying them — it would merely fail.
   *
   * `staleSince` requires the job to have sat untouched that long, so a driver toggling offline for
   * a moment between two status posts does not lose their job.
   */
  lockNextStaleAssignment(
    statuses: readonly DeliveryJobStatus[],
    staleSince: Date,
    excludeIds: readonly string[],
    tx: unknown,
  ): Promise<DeliveryJobProps | null>;
}
