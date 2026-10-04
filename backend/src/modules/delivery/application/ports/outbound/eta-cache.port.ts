import { RouteDestination } from '../../../domain/services/tracking-policy';

export const ETA_CACHE_PORT = Symbol('DELIVERY_ETA_CACHE_PORT');

/**
 * A route result, remembered along with the position it was computed from.
 *
 * The origin is the field that makes this a usable cache rather than a stale-answer generator. A
 * TTL alone would happily serve a two-kilometre-old ETA to a driver who has been riding hard for
 * twenty seconds; keeping the origin lets a reader ask the question that actually matters — *has
 * the driver moved far enough for this answer to be wrong?* — and recompute only when it has.
 * Time bounds how old the traffic model may be, distance bounds how far the route may have moved.
 * Both have to pass.
 */
export interface CachedEta {
  originLat: number;
  originLng: number;
  distanceMeters: number;
  durationSeconds: number;
  /**
   * When the route was calculated.
   *
   * Carried so the arrival time can stay **absolute** across a cache hit. A cached ETA re-derived
   * as `now + duration` would reset its own countdown every time it was read, and a customer
   * watching the screen would see "arriving in 9 minutes" for as long as the entry lived. Anchored
   * to the moment of calculation, a reused entry counts down exactly as it should.
   */
  computedAt: Date;
}

/**
 * Short-lived storage for computed ETAs (§7's "cached and refreshed", §5).
 *
 * ## Why the key carries the destination
 *
 * A job's ETA means two completely different journeys depending on where the driver is in the
 * workflow — to the pharmacy before pickup, to the customer after it — and the two are computed
 * against different destinations with different answers. Keying on the job alone would let the
 * pickup ETA survive the `PICKED_UP` transition and be served as the dropoff ETA, telling a
 * customer their medicines were two minutes away at the moment they actually started a
 * twenty-minute ride across the city. The destination is in the key, so the transition changes the
 * key and the stale entry is simply never looked at again.
 *
 * ## Not a system of record, and never load-bearing
 *
 * Exactly like `ILocationCachePort`: a miss is "recompute", never "no ETA", and every
 * implementation may legally be a no-op. That is what keeps `REDIS_URL` optional — an
 * unconfigured deployment recomputes more often and is otherwise identical. Nothing here is ever
 * read to decide anything about delivery state.
 *
 * Correctness does not depend on process memory. The Redis-backed implementation is shared across
 * instances, so a customer whose socket lands on a different node than the driver's next fix sees
 * the same ETA rather than a separately-computed one; the in-process fallback only ever costs
 * extra provider calls, which is a cost and not a wrong answer.
 */
export interface IEtaCachePort {
  /** The remembered route for this job and destination, or `null` to recompute. */
  get(jobId: string, destination: RouteDestination): Promise<CachedEta | null>;

  /** Remembers a route under the configured TTL. Failure is not an error. */
  set(jobId: string, destination: RouteDestination, entry: CachedEta): Promise<void>;
}
