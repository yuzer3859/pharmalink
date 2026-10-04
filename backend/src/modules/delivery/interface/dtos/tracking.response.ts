import { JobTrackingView } from '../../application/queries/get-job-tracking.query';
import { EtaView } from '../../application/services/eta.service';

/**
 * What a customer is told about a delivery in progress (§10's customer-visible data, F-TRK-03).
 *
 * An explicit allow-list, like every other response in this module, and here the list is the
 * feature's privacy boundary rather than a formatting convenience. A delivery job internally knows
 * the driver carrying it, the pharmacy it was collected from, the branch, the manifest of
 * medicines, whether it is cash on delivery and how much that cash is. **None of it appears
 * below**, and none of it can appear by accident: this type is built field by field from
 * `JobTrackingView`, which is itself built field by field from the aggregate, so a column added to
 * `delivery_jobs` reaches a customer only if somebody adds it here on purpose.
 *
 * What is deliberately absent, and why each one:
 *
 *  - **The driver.** No id, no name, no phone, no vehicle, no verification state. §11 of this
 *    work's brief says outright not to invent a public driver-profile surface, and a driver's
 *    identity is their personal data rather than a property of the parcel. The design does promise
 *    the customer driver information eventually; it arrives when there is a safe summary contract
 *    to serve it from, not as a field quietly added to a position payload.
 *
 *    **Re-checked in Work 14's readiness pass, and the gap is unchanged.** `IdentityModule` exports
 *    exactly two things — `TOKEN_SERVICE` and `PERM_VERSION_STORE` — and there is no public
 *    profile, summary or contact contract anywhere in the repository for any module to consume.
 *    Serving a driver's name or phone here would therefore mean Module 08 reading Module 01's user
 *    tables directly and deciding for itself which fields a stranger may see, which is precisely
 *    the cross-context reach ADR-002 forbids and precisely the decision Module 01 owns. So the
 *    response is left as location plus ETA, and the remaining gap is recorded rather than filled:
 *    a customer-visible driver summary needs Module 01 to publish one first.
 *  - **The order's contents, the pharmacy, and any money.** Module 06 and Module 07 own those and
 *    already serve them to the same customer through their own authorized reads. Copying them onto
 *    a tracking payload would widen the blast radius of a tracking bug to include the medicines
 *    somebody is taking.
 *  - **The route's shape.** The ETA below carries a distance and a duration; it deliberately does
 *    not carry a polyline. Drawing the driver's road path is a real feature with a real bandwidth
 *    cost on every fix, and it belongs to the work that decides the customer app needs it.
 *  - **Anything internal** — `assignedDriverId`, audit context, history rows, cache metadata.
 *
 * `fulfillmentId` *is* included, and is the one identifier here that needs justifying. An order
 * split across two pharmacies produces two deliveries, and without it a client watching both has
 * no way to tell which half of their order is at the door. It identifies a leg of the customer's
 * own order, which they can already read from Module 06.
 */
export interface TrackingResponse {
  jobId: string;
  orderId: string;
  fulfillmentId: string;
  status: string;
  /** `null` when no position has been recorded yet — a normal answer, not an error (§6). */
  location: { lat: number; lng: number; recordedAt: string } | null;
  /** Whether this delivery is currently in a state that produces position updates. */
  isLive: boolean;
  /**
   * Whether it has finished.
   *
   * Present so a client can tell "the map has stopped because the delivery is over" from "the map
   * has stopped because the driver's phone lost signal". NFR-LOC-04 asks for graceful degradation,
   * and the graceful thing is to say which of those it is rather than leave a customer watching a
   * static marker and guessing. What this deliberately does *not* do is invent an "offline" state
   * from an absence of updates: the platform does not know that a driver is offline, only that it
   * has not heard from them, and `recordedAt` already lets a client say "last seen 4 minutes ago"
   * truthfully.
   */
  isFinished: boolean;
  /**
   * The arrival estimate, or `null` when there is not one worth giving (F-TRK-02).
   *
   * Three numbers and a label, and nothing that could identify where they came from. A routing
   * vendor's response carries polylines, leg breakdowns, traffic annotations and its own
   * identifiers; `RouteResult` normalises all of it to a distance and a duration at the port, so
   * there is no provider-specific field that *could* reach here — replacing the adapter changes
   * nothing a client can observe.
   *
   * `null` is the ordinary answer, not an error: the job is finished, or the driver has not
   * reported, or their last position is too old to trust, or the routing provider is down. A
   * client must handle it in all four cases and is told the same thing in each, because
   * distinguishing them on the wire would amount to the customer-visible "driver offline" state
   * this module has twice declined to invent.
   */
  eta: {
    /** `PICKUP` while the driver is collecting, `DROPOFF` once they are carrying the order. */
    destination: string;
    distanceMeters: number;
    durationSeconds: number;
    /** ISO-8601. Absolute, so a reused estimate counts down instead of resetting on every read. */
    expectedArrivalAt: string;
  } | null;
}

/**
 * The one ETA representation.
 *
 * Exported and used by both the REST mapper below and the gateway's snapshot mapper, so §7's "both
 * surfaces expose the same ETA representation" is true because there is one function rather than
 * because two were written to match.
 */
export function toEtaResponse(eta: EtaView | null): TrackingResponse['eta'] {
  return eta === null
    ? null
    : {
        destination: eta.destination,
        distanceMeters: eta.distanceMeters,
        durationSeconds: eta.durationSeconds,
        expectedArrivalAt: eta.expectedArrivalAt.toISOString(),
      };
}

export function toTrackingResponse(view: JobTrackingView): TrackingResponse {
  return {
    jobId: view.jobId,
    orderId: view.orderId,
    fulfillmentId: view.fulfillmentId,
    status: view.status,
    location:
      view.location === null
        ? null
        : {
            lat: view.location.lat,
            lng: view.location.lng,
            recordedAt: view.location.recordedAt.toISOString(),
          },
    isLive: view.isLive,
    isFinished: view.isFinished,
    eta: toEtaResponse(view.eta),
  };
}
