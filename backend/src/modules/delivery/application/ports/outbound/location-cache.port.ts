export const LOCATION_CACHE_PORT = Symbol('DELIVERY_LOCATION_CACHE_PORT');

/** A driver's position as the hot store holds it. */
export interface CachedLocation {
  lat: number;
  lng: number;
  /** When the fix was taken on the handset — the ordering key, not the arrival time. */
  recordedAt: Date;
  /**
   * The `driver_profiles.id` whose fix this is.
   *
   * Present because the entry is keyed by *job* while the position belongs to a *driver*, and a
   * reassignment separates the two: a job released from one driver pre-pickup keeps its cache
   * entry until the next driver posts, and serving that entry in the meantime would show a
   * customer the coordinates of somebody who is no longer carrying their order. Readers compare
   * this against the job's current `assignedDriverId` and discard a mismatch.
   */
  driverId: string;
}

/**
 * The hot last-known-position store (`architecture/module-08-delivery-tracking.md` §7's "writes
 * last-known location to **Redis** (hot, TTL)", §10's `ILocationCachePort`).
 *
 * ## What this is not
 *
 * **It is not the source of truth, and nothing may be written here that is not also durable.**
 * The design's phrasing — "live location primarily in Redis" — describes where reads are *served*
 * from, not where the fact lives. `driver_profiles.last_lat/last_lng/last_location_at` is the
 * authority; this port exists so the hot path can answer without a Postgres round trip and so a
 * position can be compared against the newest fix seen rather than against the last one
 * persisted, which the write throttle deliberately leaves behind.
 *
 * The consequence is that **every implementation may legally be a no-op**. A `get` returning
 * `null` means "ask Postgres", never "there is no position", and callers are written that way.
 * That is what keeps `REDIS_URL` optional without making an unconfigured deployment incorrect —
 * only slower, and only on the path that reads the last few seconds of movement.
 *
 * ## Keyed by job, not by driver
 *
 * The durable record is per driver, because a driver has one position. This cache is per job,
 * because a *subscriber* asks about a job and because the pub/sub channel is keyed by job. When
 * stacked deliveries arrive (§3.2 F-JOB-06) one driver will populate two entries with the same
 * coordinates, which is correct: they are two cached answers to two questions, not two claims
 * about where somebody is.
 */
export interface ILocationCachePort {
  /**
   * The hot last-known position for a job, or `null` when the cache holds nothing for it —
   * whether because it expired, because Redis is unreachable, or because Redis is not configured.
   * A caller must treat all three identically and fall back to the durable record.
   */
  get(jobId: string): Promise<CachedLocation | null>;

  /** Stores a job's last-known position under the configured TTL. Failure is not an error. */
  set(jobId: string, location: CachedLocation): Promise<void>;
}
