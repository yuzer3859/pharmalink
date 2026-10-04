export const REALTIME_PORT = Symbol('DELIVERY_REALTIME_PORT');

/**
 * What a tracking subscriber receives, and the complete list of what Module 08 will tell them
 * (§7, F-TRK-03, §10's "customer-visible data").
 *
 * Every field here is one a customer watching a map legitimately needs. Just as importantly, the
 * fields that are *absent* are absent by construction rather than by a mapper remembering to drop
 * them: there is no driver id, no driver name, no phone number, no vehicle, no verification state,
 * no profile id, no audit context, no order contents, no pharmacy, no money. The type is the
 * boundary — a later change that wanted to leak one of those would have to add it here, in a file
 * whose whole subject is what customers may see.
 *
 * `driverId` in particular is deliberately missing even though the gateway knows it. A position is
 * what the customer is owed; *who* is at that position is driver personal data, and §11 of this
 * work's brief says outright not to invent a public driver-profile surface for it. A later
 * integration can join a safe driver summary onto this stream.
 *
 * There is no `eta` either — F-TRK-02 is a separate feature with a routing adapter behind it, and
 * a field that could only ever be null would advertise a capability the platform does not have.
 */
export interface TrackingUpdate {
  /** The delivery job being tracked. Already the subscriber's own — it is how they subscribed. */
  jobId: string;
  /** Module 06's order, so a client tracking a split order can route the update to the right leg. */
  orderId: string;
  /** The fulfillment, which is what actually identifies a leg when an order splits across pharmacies. */
  fulfillmentId: string;
  lat: number;
  lng: number;
  /** When the driver's handset took the fix. ISO-8601, because this crosses a process boundary. */
  recordedAt: string;
  /** When the server accepted it. Lets a client show "updated 4s ago" without trusting the handset clock. */
  receivedAt: string;
  /** The job's status at the moment of the fix, so the map and the progress bar cannot disagree. */
  status: string;
  /**
   * The arrival estimate that goes with this position, or `null` when there is not one (§6).
   *
   * Additive to the contract the tracking work shipped: a client written against that version
   * ignores an unknown field, and one written against this must already handle `null`, because
   * `null` is the ordinary answer whenever the routing provider is unavailable or the job is not
   * on a journey. Nothing that previously appeared here has changed or moved.
   *
   * Provider-neutral by construction — a distance, a duration and a timestamp, which is what
   * `RouteResult` normalises every vendor down to. No polyline, no provider id, no raw response.
   */
  eta: {
    /** `PICKUP` before the driver collects, `DROPOFF` after — see `routeDestinationFor`. */
    destination: string;
    distanceMeters: number;
    durationSeconds: number;
    /** ISO-8601, absolute, anchored to when the route was computed rather than to now. */
    expectedArrivalAt: string;
  } | null;
}

/** Releases a subscription. Idempotent — a disconnect after an explicit unsubscribe is normal. */
export type RealtimeUnsubscribe = () => Promise<void>;

/**
 * Cross-instance fan-out for tracking updates (§7, §10's `IRealtimePort`).
 *
 * ## Why this is a port and not just "call Redis"
 *
 * The design requires **stateless WebSocket nodes**: "multiple WS nodes share subscriptions via
 * the Redis adapter; any node can serve any client". A location accepted by the node the *driver*
 * is connected to has to reach the node the *customer* is connected to, and those are routinely
 * different — nothing pins the two halves of one delivery to one process, and with a load balancer
 * in front of three nodes they will usually not be.
 *
 * Putting that behind a port buys the thing that matters for testing: the publish path and the
 * subscribe path can be exercised against an in-process implementation in unit tests, while the
 * claim that actually needs proving — that instance A's publish reaches instance B's subscriber —
 * is proved end to end against real Redis with two real gateways.
 *
 * ## Delivery semantics, stated plainly
 *
 * **At-most-once, and deliberately so.** Redis pub/sub drops messages for channels nobody is
 * listening to and does not replay anything on reconnect. That is the correct trade for this
 * payload and the wrong one for almost any other: a location fix is superseded every few seconds,
 * so a dropped one costs a customer nothing that the next one does not fix, whereas a *queued* one
 * would eventually show them a position the driver left minutes ago. Facts that must not be lost
 * go through the transactional outbox (ADR-010); this is not one of them, and the two paths are
 * kept apart precisely so neither inherits the other's guarantees.
 *
 * A reconnecting subscriber is made whole by the durable last-known position, not by replay.
 */
export interface IRealtimePort {
  /**
   * Fans an update out to every subscriber of the job, on any instance.
   *
   * Returns whether the update actually entered the transport. `false` means the fan-out did not
   * happen — Redis is unreachable or unconfigured — and the caller must not report the update as
   * relayed. It must never throw: a tracking failure cannot be allowed to fail the durable write
   * that has already happened, nor to turn a driver's location post into a 500.
   */
  publish(jobId: string, update: TrackingUpdate): Promise<boolean>;

  /**
   * Registers a listener for a job's updates and returns its release.
   *
   * The release is returned rather than keyed by listener identity because the caller is a socket
   * whose lifetime ends at a disconnect it does not control; a handle it can store is far harder
   * to leak than a reference it has to reproduce exactly.
   */
  subscribe(
    jobId: string,
    listener: (update: TrackingUpdate) => void,
  ): Promise<RealtimeUnsubscribe>;
}
