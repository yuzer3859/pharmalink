import { DeliveryJobStatus } from '../enums';
import { ACTIVE_JOB_STATUSES } from './driver-availability-policy';

/**
 * The job states in which a driver's position is a fact worth relaying
 * (`architecture/module-08-delivery-tracking.md` §7, F-TRK-01, BR-DEL-05).
 *
 * **Derived from `ACTIVE_JOB_STATUSES`, not restated.** The two questions — "does this job occupy
 * one of the driver's concurrent slots?" (BRULE-28) and "should this job's position be tracked?"
 * — have the same answer for the same underlying reason: both are asking whether a named driver
 * is currently out in the world carrying out this job. `ASSIGNED` through `ARRIVED_DROPOFF` is
 * exactly that span, and it is exactly the list the tracking work was asked to cover.
 *
 * Deriving rather than copying is the whole point of this file existing at all. A second literal
 * array would be correct on the day it was written and would drift the first time a state was
 * added: whoever added it would update the list they were looking at, and the other would silently
 * start disagreeing — a job tracked but not counted, or counted but invisible on the customer's
 * map. There is one list, and this module gives it a second name because the concepts are
 * genuinely distinct even where the extension is identical.
 *
 * What that leaves out, and why each exclusion is right:
 *
 *  - **`CREATED`, `OFFERED`, `REASSIGNING`** — no driver is attached. There is no position to
 *    report and nobody authorised to report one; a location update naming such a job is either a
 *    stale client or a probe.
 *  - **`DELIVERED`, `COMPLETED`** — the handover happened. Continuing to broadcast the driver's
 *    coordinates to the customer after that would be tracking a person rather than a delivery,
 *    which is a privacy problem and not a feature.
 *  - **`CANCELLED`, `FAILED`** — terminal. Nothing is being carried anywhere.
 */
export const TRACKABLE_JOB_STATUSES: readonly DeliveryJobStatus[] = ACTIVE_JOB_STATUSES;

/** Whether a job in this state may accept and relay driver position reports. */
export function isTrackableStatus(status: DeliveryJobStatus): boolean {
  return TRACKABLE_JOB_STATUSES.includes(status);
}

/**
 * Whether a job in this state can no longer produce position updates *and never will again*.
 *
 * Distinct from "not trackable": a `CREATED` job is untrackable now but will become trackable the
 * moment a driver accepts it, whereas a `DELIVERED` one is finished. The subscription path uses
 * this to decide whether to keep a customer's socket open waiting for movement or to tell them
 * outright that there will be none — a customer staring at a static map with no explanation is
 * the degradation NFR-LOC-04 asks us to avoid.
 */
export function isTerminalForTracking(status: DeliveryJobStatus): boolean {
  return (
    status === DeliveryJobStatus.DELIVERED ||
    status === DeliveryJobStatus.COMPLETED ||
    status === DeliveryJobStatus.CANCELLED ||
    status === DeliveryJobStatus.FAILED
  );
}

/**
 * Which end of the trip a driver is currently heading for (§3.4 F-TRK-02, §11.4).
 *
 * `NONE` is a real answer rather than a gap: a job with no driver, or a finished one, has no
 * journey in progress and therefore no destination. Callers turn it into "ETA unavailable", which
 * §4 requires in preference to a fabricated zero.
 */
export enum RouteDestination {
  Pickup = 'PICKUP',
  Dropoff = 'DROPOFF',
  None = 'NONE',
}

/**
 * The destination a job's ETA should be computed against, decided from its status alone.
 *
 * **The pickup boundary is the whole rule, and this is its only statement of it.** Before the
 * driver has the medicines they are riding to the pharmacy, so the useful answer to "when will it
 * arrive?" is when they reach the *branch*; from `PICKED_UP` onwards the goods are on the bike and
 * the customer's own door is what matters. §11.4 draws the line in exactly that place, and the
 * state machine already treats it as the point of no return — past it a job can no longer be
 * cancelled or reassigned.
 *
 * Deriving it here, from the status, is what stops it being written down twice. The live fan-out
 * and the snapshot read both need a destination and they must never disagree: a customer whose
 * socket said "12 minutes to your door" while a refresh said "2 minutes to the pharmacy" would be
 * watching two different deliveries. One function, two callers.
 *
 * `ARRIVED_PICKUP` still routes to the pickup. The driver is standing at the pharmacy, so the
 * honest ETA is approximately zero — which is a true statement about the journey they are on, and
 * better than pretending they have already set off for a dropoff they have not been given yet.
 */
export function routeDestinationFor(status: DeliveryJobStatus): RouteDestination {
  switch (status) {
    case DeliveryJobStatus.ASSIGNED:
    case DeliveryJobStatus.ARRIVED_PICKUP:
      return RouteDestination.Pickup;
    case DeliveryJobStatus.PICKED_UP:
    case DeliveryJobStatus.EN_ROUTE:
    case DeliveryJobStatus.ARRIVED_DROPOFF:
      return RouteDestination.Dropoff;
    default:
      // Every non-trackable state: nothing is moving, so nothing is arriving.
      return RouteDestination.None;
  }
}

export const TrackingPolicy = {
  TRACKABLE_JOB_STATUSES,
  isTrackableStatus,
  isTerminalForTracking,
  routeDestinationFor,
};
