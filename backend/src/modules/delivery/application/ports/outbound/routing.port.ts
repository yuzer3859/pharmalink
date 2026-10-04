import { GeoPoint } from '../../../domain/value-objects/geo-point.vo';

export const ROUTING_PORT = Symbol('DELIVERY_ROUTING_PORT');

/** Two points on the ground. Nothing about the job, the driver, or why the route is wanted. */
export interface RouteRequest {
  origin: GeoPoint;
  destination: GeoPoint;
}

/**
 * A road route between two points, normalised to the two numbers this platform actually uses.
 *
 * Deliberately not a provider's response. Every routing vendor returns far more — polylines, turn
 * lists, leg breakdowns, traffic annotations, its own ids — and every one of them shapes it
 * differently. Projecting to distance and duration at the boundary is what makes the vendor
 * replaceable: the ETA a customer sees is computed from these two numbers, so swapping
 * OpenRouteService for Mapbox changes one adapter and nothing else.
 *
 * There is no geometry field, and that is a decision rather than an omission. Drawing the driver's
 * road path on the customer's map would be a genuine feature, and it would also mean a polyline
 * crossing the tracking payload on every fix; it belongs to whichever work decides the customer
 * app needs it, together with the bandwidth question that comes with it.
 */
export interface RouteResult {
  /** Road distance in metres — not the straight line. */
  distanceMeters: number;
  /** Expected travel time in seconds, under whatever conditions the provider models. */
  durationSeconds: number;
}

/**
 * Route and travel-time calculation (`architecture/module-08-delivery-tracking.md` §7's "**ETA** —
 * computed via mapping adapter (`IRoutingPort`) or heuristic", §10's `IRoutingPort (maps/ETA)`).
 *
 * ## The vendor stops here
 *
 * Nothing in the domain or application layer may know that a route came from Google, Mapbox,
 * OpenRouteService or OSRM, and this type is where that is enforced. `GeoPoint` in, distance and
 * duration out — no API key, no request options, no provider identifier, no vendor error type. A
 * module that cannot name a provider cannot become coupled to one.
 *
 * `dispatch-policy.ts` has been pointing at this port since the dispatch work: its `haversineMeters`
 * comment says outright that road distance "is `IRoutingPort`'s (§7), which does not exist yet".
 * It does now. Dispatch ranking still uses the straight line deliberately — ranking compares
 * candidates against each other and a road-distance call per candidate would put a provider
 * round-trip on the dispatch path — while a customer-facing ETA, which is a claim about the real
 * world, comes from here.
 *
 * ## It does not throw, and that is part of the contract
 *
 * `route` answers `null` when it cannot produce one: the provider is down, the points are
 * unroutable, the request timed out. **Failure is a value, not an exception**, for the same reason
 * `IRealtimePort.publish` returns a boolean — a map service being unavailable is an ordinary
 * operational condition, and the correct response to it is a delivery with no ETA, never a failed
 * request or a job left in a state nobody intended (§9). An implementation that throws anyway is a
 * broken implementation, and `EtaService` guards against one rather than trusting the contract,
 * because the eventual implementation will be somebody else's HTTP client.
 *
 * A `null` therefore means exactly one thing to every caller: no ETA this time, show the position
 * and say nothing about arrival.
 */
export interface IRoutingPort {
  route(request: RouteRequest): Promise<RouteResult | null>;
}
