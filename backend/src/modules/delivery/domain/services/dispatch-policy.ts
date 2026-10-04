import { DriverProfileProps } from '../entities/driver-profile.entity';
import { DriverAvailability } from '../enums';
import { GeoPoint } from '../value-objects/geo-point.vo';
import { hasCapacity, resolveConcurrentLimit } from './driver-availability-policy';

/**
 * Mean Earth radius, metres. The haversine formula's only constant.
 */
const EARTH_RADIUS_METERS = 6_371_008.8;

/**
 * Great-circle distance between two points, in metres.
 *
 * Haversine rather than a projected or ellipsoidal calculation: at the scale a delivery driver
 * operates — a city, tens of kilometres — its error against a true geodesic is a fraction of a
 * percent, which is far smaller than the error already introduced by the fact that a driver
 * follows roads rather than a straight line. A more accurate straight-line distance would not
 * make the *ranking* more accurate; road distance would, and that is `IRoutingPort`'s (§7), which
 * does not exist yet.
 */
export function haversineMeters(a: GeoPoint, b: GeoPoint): number {
  const toRad = (deg: number): number => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);

  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Whether a driver's declared service area covers a pickup point (§6.1's "within pickup service
 * radius", task 1's "within the configured service area").
 *
 * **A driver who has declared no service area serves everywhere.** This is a fail-*open* filter,
 * unlike the verification gate beside it, and the asymmetry is deliberate. Verification is a
 * safety rule, so its absence must refuse. A service area is a driver's own preference, `null` by
 * default on a freshly created profile, and treating "not yet configured" as "serves nowhere"
 * would make every new driver permanently undispatchable with nothing anywhere to explain why —
 * an invisible starvation nobody would think to look for. Offering a job to a driver who has not
 * narrowed their range is self-correcting: they decline, and dispatch moves on in one round.
 */
export function servesPickup(driver: DriverProfileProps, pickup: GeoPoint | null): boolean {
  const area = driver.serviceArea;
  if (area === null) {
    return true;
  }
  if (pickup === null) {
    // The job has no pickup coordinate (a soft-deleted branch, per the job-creation work's
    // degradation). Nothing can be excluded on distance it does not have, so the area is not
    // applied rather than applied as a refusal.
    return true;
  }
  return haversineMeters(area.center, pickup) <= area.radiusMeters;
}

/**
 * A driver who passed every Delivery-owned eligibility filter, scored and ready to be offered.
 *
 * The type is the seam the design's §14 asks for — "pluggable `DispatchScoring` allows batch/
 * stacked deliveries, zone-based pre-positioning, and ML-based ETA/assignment later (behind the
 * same interface)". A future ranking replaces `score` and the function that computes it; nothing
 * in the dispatch, accept, decline or reassign workflow reads anything else, so none of them has
 * to change.
 *
 * It deliberately carries the *inputs* to the score alongside the score itself. An operator asking
 * why a particular driver was chosen needs to see the distance and the load, not a number.
 */
export interface DispatchCandidate {
  driver: DriverProfileProps;
  /** Metres from the driver's last-known position to the pickup, or `null` when unknown. */
  distanceMeters: number | null;
  /** Jobs the driver is already holding (BRULE-28's count). */
  activeJobCount: number;
  /** The driver's effective concurrent-job limit — per-driver override, or the platform default. */
  limit: number;
  /** Higher is better. See `rankCandidates` for the formula and its weights. */
  score: number;
}

/** What `rankCandidates` needs to know about the job and the platform. */
export interface DispatchContext {
  pickup: GeoPoint | null;
  /** `delivery.maxConcurrentJobs`. Per-driver overrides take precedence (BRULE-28). */
  platformConcurrentLimit: number;
  /** Active-job counts by `driver_profiles.id`, from one grouped query. */
  activeJobCounts: ReadonlyMap<string, number>;
  /** Driver profile ids that must not be offered this job — see `DispatchDeliveryJobCommand`. */
  excludedDriverIds?: ReadonlySet<string>;
}

/**
 * The distance at which the proximity term reaches zero.
 *
 * Not a hard filter — a driver further than this is still a candidate, and will still be chosen
 * if they are the only one. It is the scale over which proximity stops discriminating: past 15km
 * in a city, the difference between two drivers is traffic rather than distance, and pretending
 * otherwise would let a marginally-closer but much busier driver win.
 */
export const PROXIMITY_SCALE_METERS = 15_000;

/**
 * How much each term is worth. They sum to 1, so a score is always in `[0, 1]` and is readable.
 *
 * §6.2's formula is `w_dist·proximity + w_fair·(inverse recent-job-count) + w_rating·rating`, and
 * **the rating term is deliberately not implemented**. `driver_profiles.rating_avg` exists but is
 * Module 15's column, nothing writes it, and every driver's value is exactly `0`. A term that is
 * identically zero for everyone does not break ties, does not rank anyone, and costs nothing to
 * omit — but included, it would look like a working input and would quietly start reordering
 * every dispatch on the platform the day Module 15 first wrote a rating, with nobody having
 * chosen that. It is added by the work that makes ratings real.
 *
 * Distance is weighted above fairness because a customer waiting for medicine is the stronger
 * interest, and because fairness has a floor the weights cannot remove: the concurrent-job limit
 * already stops any one driver hoarding work.
 */
export const PROXIMITY_WEIGHT = 0.7;
export const FAIRNESS_WEIGHT = 0.3;

/**
 * Filters and ranks (§6.1–§6.2). **Pure**: no clock, no repository, no I/O, no Module 01 read.
 *
 * The filters applied here are exactly the ones Delivery can answer from its own state:
 *
 *  - `ONLINE` — `BUSY` and `OFFLINE` are both excluded. A `BUSY` driver is at their limit by
 *    definition, and the capacity filter below would exclude them anyway; excluding them by
 *    availability as well costs nothing and means the two never disagree.
 *  - on shift — implied by `ONLINE` through `DriverAvailabilityPolicy.isConsistent`, and checked
 *    again because a row that drifted must not become dispatchable.
 *  - under the concurrent-job limit (BRULE-28), from counts the caller supplies.
 *  - within the declared service area — see `servesPickup`.
 *  - not excluded — the job's previous driver and everyone who has already been offered it.
 *
 * **Module 01 verification is not applied here, and cannot be**: it is I/O against another bounded
 * context. `DispatchCandidateService` walks this ranked list and asks `IIdentityPort` about each
 * candidate in turn, which is both correct (the authoritative source, read live) and cheap (the
 * first candidate usually passes, so it is usually one read rather than one per driver).
 *
 * ## The score
 *
 * ```
 * score = 0.7 · proximity + 0.3 · fairness
 * proximity = 1 - min(distance, 15km) / 15km        (1 at the pickup, 0 at 15km and beyond)
 * fairness  = 1 - activeJobCount / limit            (1 when idle, approaching 0 at the limit)
 * ```
 *
 * A driver whose location is unknown scores `0` on proximity rather than being excluded: a driver
 * who has just come online has no fix yet, and refusing to dispatch to them would idle exactly
 * the drivers who most recently made themselves available. They rank below every located driver
 * and above nobody, which is the honest ordering for "we do not know where they are".
 *
 * ## Determinism
 *
 * Ties break on `driver.id`, which is a stable total order. This matters more than it looks:
 * dispatch runs again after every decline and every expiry, and a ranking that reordered equal
 * candidates between runs could offer the same job to the same driver twice while skipping
 * another entirely. The whole function is a pure map-filter-sort, so the same inputs always give
 * the same list.
 */
export function rankCandidates(
  drivers: readonly DriverProfileProps[],
  context: DispatchContext,
): DispatchCandidate[] {
  const excluded = context.excludedDriverIds ?? new Set<string>();

  const candidates: DispatchCandidate[] = [];
  for (const driver of drivers) {
    if (excluded.has(driver.id)) {
      continue;
    }
    if (driver.availability !== DriverAvailability.ONLINE || driver.shiftStartedAt === null) {
      continue;
    }
    if (!servesPickup(driver, context.pickup)) {
      continue;
    }

    const activeJobCount = context.activeJobCounts.get(driver.id) ?? 0;
    const limit = resolveConcurrentLimit(driver.maxConcurrent, context.platformConcurrentLimit);
    if (!hasCapacity(activeJobCount, limit)) {
      continue;
    }

    const distanceMeters =
      context.pickup !== null && driver.lastLocation !== null
        ? haversineMeters(driver.lastLocation, context.pickup)
        : null;

    candidates.push({
      driver,
      distanceMeters,
      activeJobCount,
      limit,
      score: scoreOf(distanceMeters, activeJobCount, limit),
    });
  }

  return candidates.sort(
    (a, b) => b.score - a.score || (a.driver.id < b.driver.id ? -1 : 1),
  );
}

function scoreOf(
  distanceMeters: number | null,
  activeJobCount: number,
  limit: number,
): number {
  const proximity =
    distanceMeters === null
      ? 0
      : 1 - Math.min(distanceMeters, PROXIMITY_SCALE_METERS) / PROXIMITY_SCALE_METERS;
  // `limit` is always >= 1 (`resolveConcurrentLimit` rejects non-positive overrides), so this
  // cannot divide by zero, and a candidate that reached here is under their limit, so it cannot
  // go negative.
  const fairness = 1 - activeJobCount / limit;
  return PROXIMITY_WEIGHT * proximity + FAIRNESS_WEIGHT * fairness;
}

export const DispatchPolicy = {
  haversineMeters,
  servesPickup,
  rankCandidates,
  PROXIMITY_WEIGHT,
  FAIRNESS_WEIGHT,
  PROXIMITY_SCALE_METERS,
} as const;
