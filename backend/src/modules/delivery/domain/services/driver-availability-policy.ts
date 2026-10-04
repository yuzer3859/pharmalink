import { DeliveryJobStatus, DriverAvailability } from '../enums';

/**
 * The rules governing a driver's operational state — availability, shift, and the concurrent-job
 * limit (`architecture/module-08-delivery-tracking.md` §3.1 F-DRV-02/F-DRV-04, BRULE-28).
 *
 * Pure, like `DeliveryStatusPolicy` beside it: no clock, no repository, no I/O. It answers "is
 * this combination legal?" and nothing else, so the rules can be read in one place and tested
 * without a database.
 */

/**
 * The job states in which a driver is **occupying one of their concurrent slots** (BRULE-28).
 *
 * The span is "this driver is responsible for this job right now": from the moment they take it
 * on (`ASSIGNED`) until they hand it over (`ARRIVED_DROPOFF` is the last state before the
 * handover completes). Each exclusion is deliberate and each one matters in a different
 * direction:
 *
 * - **`CREATED` / `OFFERED`** — nobody holds the job. `assignedDriverId` is still null, so these
 *   rows could not be attributed to a driver even if they should be. An offer *pending* a
 *   driver's answer is a real question (should a driver with two open offers get a third?), and
 *   it is the dispatch work's to answer, in `job_offers`, where offers actually live.
 * - **`REASSIGNING`** — the driver is being *released*, not held. `DeliveryStatusPolicy` lets
 *   this state leave only to `OFFERED` or `CANCELLED`, never back to `ASSIGNED`, so the original
 *   driver provably never regains the job. Counting it would freeze a slot of theirs for as long
 *   as ops took to re-dispatch somebody else's problem.
 * - **`DELIVERED` / `COMPLETED`** — the medicines are with the customer. `COMPLETED` trails
 *   `DELIVERED` only to leave room for earnings accrual and COD reconciliation (later works), and
 *   a driver must not be blocked from their next job while the books are squared.
 * - **`CANCELLED` / `FAILED`** — terminal, and nobody is carrying anything.
 *
 * Consistency with `DeliveryStatusPolicy` is not automatic and must not be assumed: its unit
 * tests and this module's own assert the two agree.
 */
export const ACTIVE_JOB_STATUSES: readonly DeliveryJobStatus[] = [
  DeliveryJobStatus.ASSIGNED,
  DeliveryJobStatus.ARRIVED_PICKUP,
  DeliveryJobStatus.PICKED_UP,
  DeliveryJobStatus.EN_ROUTE,
  DeliveryJobStatus.ARRIVED_DROPOFF,
];

/**
 * The availability values a driver may set for themselves (§3.1 F-DRV-02's "availability toggle").
 *
 * `BUSY` is absent on purpose. It is not a preference a driver expresses; it is the platform's
 * observation that they are at their concurrent limit, and it is dispatch's to write when it
 * assigns the job that fills the last slot. A driver who could set `BUSY` by hand would be able
 * to take themselves out of rotation while still appearing on shift, which is a state nobody
 * downstream could interpret.
 */
export const DRIVER_SETTABLE_AVAILABILITY: readonly DriverAvailability[] = [
  DriverAvailability.ONLINE,
  DriverAvailability.OFFLINE,
];

export function isDriverSettableAvailability(value: unknown): value is DriverAvailability {
  return DRIVER_SETTABLE_AVAILABILITY.includes(value as DriverAvailability);
}

/**
 * The availability values that mean "the driver is working right now" — the ones that must be
 * accompanied by an open shift.
 *
 * `BUSY` is here even though a driver cannot set it: a driver at their concurrent limit is, by
 * definition, working. Leaving it out would make "BUSY while off shift" a legal state, which is a
 * contradiction the whole shift concept exists to prevent.
 */
export const WORKING_AVAILABILITY: readonly DriverAvailability[] = [
  DriverAvailability.ONLINE,
  DriverAvailability.BUSY,
];

export function isWorkingAvailability(availability: DriverAvailability): boolean {
  return WORKING_AVAILABILITY.includes(availability);
}

/**
 * **The single invariant tying availability to shift.**
 *
 * A driver may be on shift and `OFFLINE` — a break, a meal, a refuel — but may never be `ONLINE`
 * or `BUSY` without an open shift. The asymmetry is the point: "on shift" is the outer window
 * within which availability moves, so one direction is a normal pause and the other is a
 * contradiction.
 *
 * Everything else about shifts and availability is derived from this one rule. Ending a shift
 * forces `OFFLINE` because leaving the driver `ONLINE` would violate it; going `ONLINE` without a
 * shift is refused for the same reason.
 */
export function isConsistent(
  availability: DriverAvailability,
  shiftStartedAt: Date | null,
): boolean {
  return shiftStartedAt !== null || !isWorkingAvailability(availability);
}

/**
 * Resolves the effective concurrent-job limit (BRULE-28, F-DRV-04's "configurable").
 *
 * Per-driver override first, platform default second — the ordinary shape of a tunable. A driver
 * with a van and a cold box may legitimately carry more than a driver on a bicycle, and that is
 * what the override is for; everyone else follows `delivery.maxConcurrentJobs`.
 *
 * A non-positive override is treated as *no* override rather than as "this driver may hold zero
 * jobs". Zero would silently and permanently remove a driver from dispatch, and nothing in the
 * design describes a way to express that — suspension is Module 01's, and going `OFFLINE` is the
 * driver's own. A stored `0` is therefore far more likely to be a bug than an intent, and the
 * safe reading of an ambiguous limit is the platform's, not a permanent exclusion nobody ordered.
 */
export function resolveConcurrentLimit(
  profileOverride: number | null | undefined,
  platformDefault: number,
): number {
  if (
    typeof profileOverride === 'number' &&
    Number.isInteger(profileOverride) &&
    profileOverride > 0
  ) {
    return profileOverride;
  }
  return platformDefault;
}

/**
 * Whether a driver holding `activeJobCount` jobs may take on one more (BRULE-28).
 *
 * Strictly less than, not less-than-or-equal: the limit is the number of jobs a driver may
 * *hold*, so a driver at the limit has no room. This is the function the dispatch work's accept
 * path will call before assigning; it is separated from the count itself so that the rule and the
 * query can be tested apart.
 */
export function hasCapacity(activeJobCount: number, limit: number): boolean {
  return activeJobCount < limit;
}

export const DriverAvailabilityPolicy = {
  ACTIVE_JOB_STATUSES,
  DRIVER_SETTABLE_AVAILABILITY,
  WORKING_AVAILABILITY,
  isDriverSettableAvailability,
  isWorkingAvailability,
  isConsistent,
  resolveConcurrentLimit,
  hasCapacity,
} as const;
