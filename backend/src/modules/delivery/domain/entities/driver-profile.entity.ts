import { DriverAvailability } from '../enums';
import { DeliveryErrors } from '../errors';
import {
  isConsistent,
  isDriverSettableAvailability,
  isWorkingAvailability,
} from '../services/driver-availability-policy';
import { GeoPoint } from '../value-objects/geo-point.vo';
import { ServiceArea } from '../value-objects/service-area.vo';
import { Vehicle } from '../value-objects/vehicle.vo';

/**
 * How far ahead of the server's clock a reported location time may be before it is rejected.
 *
 * Driver handsets set their own clocks, and a phone a minute fast is ordinary. A phone an hour
 * fast is not: accepting it would write a `lastLocationAt` no genuine later fix could beat, and
 * the driver's position would freeze on every customer's map until the clock caught up. One
 * minute absorbs real skew without leaving that trap.
 */
export const MAX_LOCATION_CLOCK_SKEW_MS = 60_000;

/**
 * The persisted shape of the operational driver profile (§5.1, §8's `driver_profiles`).
 *
 * `userId` is the only cross-context reference and it is a scalar UUID with no Prisma relation
 * (ADR-002). Note what is **not** here: no verification flag, no onboarding state, no name, no
 * phone, no licence. Module 01 owns all of it, and this aggregate is deliberately unable to
 * express an opinion about any of it — see the class comment.
 */
export interface DriverProfileProps {
  id: string;
  /** Module 01 `users.id` of a `DRIVER`-role account. One profile per driver, enforced by index. */
  userId: string;
  vehicle: Vehicle | null;
  serviceArea: ServiceArea | null;
  availability: DriverAvailability;
  /** Non-null exactly while the driver is on shift. See `DriverAvailabilityPolicy.isConsistent`. */
  shiftStartedAt: Date | null;
  lastOnlineAt: Date | null;
  /** BRULE-28 per-driver override; `null` defers to `delivery.maxConcurrentJobs`. */
  maxConcurrent: number | null;
  lastLocation: GeoPoint | null;
  lastLocationAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** What `DriverProfile.create` needs. A new profile is always off shift and `OFFLINE`. */
export interface NewDriverProfileInput {
  id: string;
  userId: string;
  vehicle?: Vehicle | null;
  serviceArea?: ServiceArea | null;
  maxConcurrent?: number | null;
  now?: Date;
}

/** The operational details a driver may edit about themselves (§9.1's `PATCH /driver/profile`). */
export interface DriverProfileUpdate {
  vehicle?: Vehicle | null;
  serviceArea?: ServiceArea | null;
  maxConcurrent?: number | null;
  now?: Date;
}

/**
 * `DriverProfile` — Module 08's operational driver aggregate root (§5.1, §3.1).
 *
 * ## The boundary, stated as what this class cannot do
 *
 * Module 01 is the source of truth for driver identity, onboarding and verification (BRULE-09).
 * That boundary is enforced here the only way a boundary survives — by omission. There is no
 * `isVerified` field, no `markVerified()`, no `suspend()`. This aggregate **cannot answer whether
 * a driver is allowed to work**, and that inability is the design.
 *
 * The Phase-0 schema had an `is_verified` column, described in §8 as a "mirror of Module 1", and
 * this work drops it. A mirrored authorization fact is not a cache: it is a second answer that
 * lags the first, and the lag fails *open* — a driver whose `DRIVER_DOCS` approval was revoked in
 * Module 01 keeps carrying medicines until somebody remembers to update the copy. The check is a
 * live read through `IIdentityPort` instead, made in the application layer at the one moment it
 * matters (going `ONLINE`), because that read is I/O and an aggregate does no I/O.
 *
 * ## What it does own
 *
 * Availability, shift, vehicle, service area, the per-driver concurrent-job override, and the
 * last-known position. One invariant binds the first two — a driver cannot be `ONLINE` or `BUSY`
 * without an open shift (`DriverAvailabilityPolicy.isConsistent`) — and every transition below is
 * that rule applied in one direction or another.
 *
 * It does **not** own the concurrent-job *count*. That is derived from `delivery_jobs` by the
 * repository, never stored here, for the reason ADR-006 gives about mutable counters: a count
 * that can be written can be wrong, and this one guards how many medicines one person is carrying.
 *
 * ## Immutability
 *
 * Every mutator returns a **new** `DriverProfile`, exactly as `DeliveryJob` does. A refused
 * transition leaves the caller's instance untouched, so a half-applied state is unrepresentable
 * rather than merely avoided.
 */
export class DriverProfile {
  private constructor(private readonly props: DriverProfileProps) {}

  /**
   * Creates a profile for a Module 01 driver.
   *
   * Always `OFFLINE` and always off shift, whatever the caller passes — there is no parameter for
   * either. A driver who appeared already online would be dispatchable before they had opened the
   * app, and the verification check that gates going online would never have run for them.
   */
  static create(input: NewDriverProfileInput): DriverProfile {
    const now = input.now ?? new Date();
    const userId = requireText(input.userId, 'userId');

    return new DriverProfile({
      id: requireText(input.id, 'id'),
      userId,
      vehicle: input.vehicle ?? null,
      serviceArea: input.serviceArea ?? null,
      availability: DriverAvailability.OFFLINE,
      shiftStartedAt: null,
      lastOnlineAt: null,
      maxConcurrent: normalizeMaxConcurrent(input.maxConcurrent),
      lastLocation: null,
      lastLocationAt: null,
      createdAt: now,
      updatedAt: now,
    });
  }

  /**
   * Rebuilds from persistence, asserting the invariants hold.
   *
   * A row that violates them is a bug that has already been committed, and loading it silently
   * would let the bug spread. Unlike the list-read path — where the repository returns props
   * without rehydrating, so one corrupt row cannot fail a whole page — every caller of this
   * method is acting on one specific driver and needs that driver to be coherent.
   */
  static rehydrate(props: DriverProfileProps): DriverProfile {
    const profile = new DriverProfile({ ...props });
    profile.assertConsistent();
    return profile;
  }

  get id(): string {
    return this.props.id;
  }

  get userId(): string {
    return this.props.userId;
  }

  get availability(): DriverAvailability {
    return this.props.availability;
  }

  get shiftStartedAt(): Date | null {
    return this.props.shiftStartedAt;
  }

  /** True while a shift is open, whatever the availability within it. */
  get isOnShift(): boolean {
    return this.props.shiftStartedAt !== null;
  }

  /** True when the driver is `ONLINE` or `BUSY` — working, as opposed to merely on shift. */
  get isWorking(): boolean {
    return isWorkingAvailability(this.props.availability);
  }

  get maxConcurrent(): number | null {
    return this.props.maxConcurrent;
  }

  get lastLocation(): GeoPoint | null {
    return this.props.lastLocation;
  }

  get lastLocationAt(): Date | null {
    return this.props.lastLocationAt;
  }

  /**
   * Starts a shift (§3.1 F-DRV-02).
   *
   * Starting an already-open shift is **idempotent**, not an error: the driver app posts this on
   * launch and after every reconnection (NFR-LOC-04's intermittent networks), and a second start
   * means "I am still on shift", not "begin a new one". Returning the unchanged profile keeps the
   * original `shiftStartedAt`, which is what a payroll or dispute question about shift length
   * would actually be asked about — resetting it on every reconnect would erase the morning.
   */
  startShift(now: Date = new Date()): DriverProfile {
    if (this.isOnShift) {
      return this;
    }
    return this.with({ shiftStartedAt: now, updatedAt: now });
  }

  /**
   * Ends a shift (§3.1 F-DRV-02).
   *
   * **Forces `OFFLINE`** rather than refusing while online. The alternative — making the driver
   * go offline first — would leave the app able to reach a state the invariant forbids by getting
   * the order wrong, and would make "I am done for the day" a two-step operation that can half
   * fail. Ending a shift is the stronger statement and subsumes the weaker one.
   *
   * Ending a shift the driver does not have is idempotent, for the same reconnection reason as
   * `startShift`.
   *
   * It does **not** cancel or reassign the driver's open jobs. §11.5 gives that to the
   * reassignment flow, which needs to find another driver before taking this one's work away;
   * doing it here would strand medicines that are already in a bag. A driver who ends a shift
   * mid-delivery is an operational condition the dispatch work's sweeper resolves.
   */
  endShift(now: Date = new Date()): DriverProfile {
    if (!this.isOnShift) {
      return this;
    }
    return this.with({
      shiftStartedAt: null,
      availability: DriverAvailability.OFFLINE,
      updatedAt: now,
    });
  }

  /**
   * Sets availability (§3.1 F-DRV-02's toggle).
   *
   * Refuses `BUSY`: it is dispatch's to write, not the driver's to choose — see
   * `DRIVER_SETTABLE_AVAILABILITY`. Refuses `ONLINE` without an open shift, which is the
   * invariant. Repeating the current value is idempotent and does not restamp `lastOnlineAt`,
   * because a retried request must not look like a new sign-on.
   *
   * **The verification requirement (BRULE-09) is not checked here** and cannot be: it is a Module
   * 01 fact, reachable only by I/O, and this aggregate does none. `SetDriverAvailabilityCommand`
   * makes that check immediately before calling this method.
   */
  setAvailability(availability: DriverAvailability, now: Date = new Date()): DriverProfile {
    if (!isDriverSettableAvailability(availability)) {
      throw DeliveryErrors.availabilityConflict(
        `A driver may only set ${DriverAvailability.ONLINE} or ${DriverAvailability.OFFLINE}; ` +
          `${DriverAvailability.BUSY} is set by dispatch when the concurrent-job limit is reached.`,
        { availability },
      );
    }
    if (availability === this.props.availability) {
      return this;
    }
    if (isWorkingAvailability(availability) && !this.isOnShift) {
      throw DeliveryErrors.availabilityConflict(
        'A driver must start a shift before going online.',
        { availability, onShift: false },
      );
    }
    return this.with({
      availability,
      ...(availability === DriverAvailability.ONLINE ? { lastOnlineAt: now } : {}),
      updatedAt: now,
    });
  }

  /**
   * Records a position report (§3.1 F-DRV-03, §5.1's `DriverLocation`).
   *
   * ## Two different kinds of bad input, handled two different ways
   *
   * A coordinate out of range, or a timestamp meaningfully ahead of the server's clock, is a
   * **defect** — a broken client or a badly-set phone — and is thrown, so it is visible.
   *
   * A timestamp at or before the one already stored is **expected** and is silently ignored,
   * returning the profile unchanged. NFR-LOC-04 requires the driver app to buffer while
   * disconnected and flush on reconnect, so out-of-order arrival is normal operation, not an
   * error. Applying such a point would drag the driver backwards on the customer's live map;
   * rejecting it with an error would have a well-behaved app retrying a request that can never
   * succeed. The caller learns which happened from `UpdateDriverLocationResult.applied`.
   *
   * ## Why a location may be recorded while offline
   *
   * F-DRV-03 describes updates "while online", and this method does not enforce that. A driver
   * carrying medicines who goes offline mid-route — a break, a dead battery, a tunnel — is
   * precisely when a last-known position matters most, and discarding those fixes would blank the
   * customer's map for the leg of the journey they most want to see. Availability governs whether
   * a driver is *offered work*; it is not a mute button on where they are.
   */
  recordLocation(point: GeoPoint, recordedAt: Date, now: Date = new Date()): DriverProfile {
    if (!(recordedAt instanceof Date) || Number.isNaN(recordedAt.getTime())) {
      throw DeliveryErrors.validation('recordedAt must be a valid date.', {
        field: 'recordedAt',
      });
    }
    if (recordedAt.getTime() - now.getTime() > MAX_LOCATION_CLOCK_SKEW_MS) {
      throw DeliveryErrors.validation('recordedAt is too far in the future.', {
        field: 'recordedAt',
        maxSkewMs: MAX_LOCATION_CLOCK_SKEW_MS,
      });
    }
    const previous = this.props.lastLocationAt;
    if (previous !== null && recordedAt.getTime() <= previous.getTime()) {
      return this;
    }
    return this.with({ lastLocation: point, lastLocationAt: recordedAt, updatedAt: now });
  }

  /**
   * Updates the operational details a driver may edit (§9.1's `PATCH /driver/profile`).
   *
   * Absent keys are left alone and an explicit `null` clears the field — the distinction matters,
   * because "I did not mention my service area" and "I no longer restrict where I work" are
   * different statements and a partial update must be able to make either.
   */
  updateDetails(update: DriverProfileUpdate): DriverProfile {
    const now = update.now ?? new Date();
    return this.with({
      ...('vehicle' in update ? { vehicle: update.vehicle ?? null } : {}),
      ...('serviceArea' in update ? { serviceArea: update.serviceArea ?? null } : {}),
      ...('maxConcurrent' in update
        ? { maxConcurrent: normalizeMaxConcurrent(update.maxConcurrent) }
        : {}),
      updatedAt: now,
    });
  }

  /**
   * Every invariant, checked together.
   *
   * Kept as one method rather than scattered through the mutators because a rule that is only
   * enforced on the path that happens to set it is not an invariant — it is a validation. This
   * runs on rehydration, so a row that has drifted (a hand-run UPDATE, a future migration) is
   * caught at the boundary rather than acted upon.
   */
  assertConsistent(): void {
    if (!isConsistent(this.props.availability, this.props.shiftStartedAt)) {
      throw DeliveryErrors.availabilityConflict(
        `A driver cannot be ${this.props.availability} without an open shift.`,
        { availability: this.props.availability, onShift: false },
      );
    }
    if (this.props.maxConcurrent !== null && this.props.maxConcurrent <= 0) {
      throw DeliveryErrors.validation('maxConcurrent must be a positive whole number or null.', {
        field: 'maxConcurrent',
      });
    }
    // Both-or-neither, the same rule `GeoPoint.optional` applies to a job's pickup point: a
    // position with no time cannot be ordered against the next report, and a time with no
    // position would block every later fix that is older than it.
    if ((this.props.lastLocation === null) !== (this.props.lastLocationAt === null)) {
      throw DeliveryErrors.validation(
        'lastLocation and lastLocationAt must both be present or both be absent.',
        { field: this.props.lastLocation === null ? 'lastLocation' : 'lastLocationAt' },
      );
    }
  }

  toProps(): DriverProfileProps {
    return { ...this.props };
  }

  private with(changes: Partial<DriverProfileProps>): DriverProfile {
    const next = new DriverProfile({ ...this.props, ...changes });
    next.assertConsistent();
    return next;
  }
}

/**
 * A non-positive or non-integer override is stored as `null` rather than rejected.
 *
 * `DriverAvailabilityPolicy.resolveConcurrentLimit` already reads such a value as "no override";
 * normalising it on the way in means the column and the policy agree, instead of the database
 * holding a number that the policy quietly ignores.
 */
function normalizeMaxConcurrent(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    return null;
  }
  return value;
}

function requireText(value: string, field: string): string {
  const text = (value ?? '').trim();
  if (!text) {
    throw DeliveryErrors.validation(`${field} is required.`, { field });
  }
  return text;
}
