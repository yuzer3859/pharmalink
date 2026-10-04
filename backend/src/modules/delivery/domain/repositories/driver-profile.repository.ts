import { DriverProfileProps } from '../entities/driver-profile.entity';

export const DRIVER_PROFILE_REPOSITORY = Symbol('DRIVER_PROFILE_REPOSITORY');

/**
 * The subset of a profile a location report changes.
 *
 * Separate from the general `save` because it is separate in kind: position reports arrive every
 * few seconds per driver (NFR-PERF-04's ≤10s), touch three columns, and must not be written
 * inside the `Serializable` transaction the audited mutations use. Giving them their own narrow
 * method makes that difference explicit rather than a convention someone has to remember.
 */
export interface DriverLocationUpdate {
  lat: number;
  lng: number;
  recordedAt: Date;
}

/**
 * Persistence port for the `DriverProfile` aggregate (§5.1, §8's `driver_profiles`).
 *
 * Domain snapshots in, domain snapshots out — no Prisma type crosses this boundary (ADR-002).
 *
 * ## What is deliberately absent
 *
 * **No candidate-driver search.** §6's dispatch needs "available drivers near this pickup, under
 * their limit, in service area" and that query is the heart of the dispatch algorithm — it needs
 * a scoring rule, a radius policy and very likely a geospatial index, none of which exist yet.
 * Guessing its signature now would fix those decisions before the work that has to make them.
 *
 * **No delete.** A driver who stops working has their profile go `OFFLINE`; the profile is the
 * record of who carried what, and deleting it would orphan every job, earning and COD collection
 * that references it.
 */
export interface IDriverProfileRepository {
  /**
   * The operational profile for a Module 01 driver, if one exists.
   *
   * This is the idempotency lookup for profile creation and the entry point for every driver-side
   * operation, because every caller knows the authenticated `users.id` and not the profile id.
   */
  findByUserId(userId: string, tx?: unknown): Promise<DriverProfileProps | null>;

  findById(id: string, tx?: unknown): Promise<DriverProfileProps | null>;

  /**
   * Drivers who are operationally available for dispatch: `ONLINE`, with an open shift.
   *
   * **The coarse filter only.** Service area, the concurrent-job limit and Module 01 verification
   * are all applied above this boundary — the first two by `DispatchPolicy.rankCandidates`, which
   * is pure and therefore testable without a database, and the third by `IIdentityPort`, which
   * belongs to another bounded context and must never be joined to (ADR-002).
   *
   * Pushing those into the query would be the obvious optimisation and would be wrong in two
   * different ways: the service-area test is a distance computation against a `Json` column that
   * SQL cannot index today, and the verification test would need a join across a context
   * boundary. What *is* pushed down is the one predicate that is both selective and indexed
   * (`driver_profiles_availability_idx`).
   *
   * `limit` bounds the scan. It is a pool size, not a result size: the ranking picks one driver
   * from it, so it only needs to be large enough that the best driver is very unlikely to fall
   * outside it. §14's geospatial index is what eventually replaces this with a bounded radius
   * query.
   */
  findDispatchCandidates(limit: number, tx?: unknown): Promise<DriverProfileProps[]>;

  /** Inserts a profile the domain has already validated (`DriverProfile.create(...).toProps()`). */
  create(profile: DriverProfileProps, tx?: unknown): Promise<DriverProfileProps>;

  /**
   * Persists availability, shift, vehicle, service area and the concurrent-job override.
   *
   * A whole-aggregate write rather than a compare-and-set, unlike `IDeliveryJobRepository`'s
   * `updateState`, and the difference is real rather than an oversight. A delivery job is posted
   * to by two parties whose reports can cross — a driver's app and an ops sweeper — so a stale
   * write there could erase a committed fact about where medicines are. A driver's availability
   * has exactly one author, the driver, and their last instruction is the one they meant; a
   * compare-and-set would reject a legitimate "go offline" because a location update had bumped
   * the row in between.
   *
   * The `Serializable` transaction the audited commands run in is what keeps two of the driver's
   * own concurrent requests from interleaving.
   */
  save(profile: DriverProfileProps, tx?: unknown): Promise<DriverProfileProps>;

  /**
   * Writes only the last-known position, and only ever forwards in time.
   *
   * Outside the audited-mutation path on purpose: see `DriverLocationUpdate`.
   *
   * **Monotonic.** A report older than or equal to the stored one leaves the row untouched. That
   * guarantee belongs at this boundary rather than in the caller because position reports race
   * with themselves — a buffered flush arriving beside a live fix, across several API nodes — and
   * a read-then-write in application code cannot settle a race it does not observe.
   *
   * Returns **what is now stored**, which is not necessarily what was passed: a caller that needs
   * to know whether its own report won compares `lastLocationAt` against the one it sent. `null`
   * means the profile does not exist, and nothing else.
   */
  updateLocation(
    id: string,
    update: DriverLocationUpdate,
    tx?: unknown,
  ): Promise<DriverProfileProps | null>;
}
