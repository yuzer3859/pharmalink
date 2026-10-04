import { Inject, Injectable } from '@nestjs/common';
import { CONFIG_PORT, IConfigPort } from '../../../../shared/config/config.port';
import {
  DEFAULT_DELIVERY_LOCATION_WRITE_INTERVAL_SECONDS,
  MAX_DELIVERY_LOCATION_WRITE_INTERVAL_SECONDS,
  MIN_DELIVERY_LOCATION_WRITE_INTERVAL_SECONDS,
} from '../../../../shared/config/delivery.config';
import { DriverProfile } from '../../domain/entities/driver-profile.entity';
import { DeliveryJobStatus } from '../../domain/enums';
import { DeliveryErrors } from '../../domain/errors';
import {
  DELIVERY_JOB_REPOSITORY,
  IDeliveryJobRepository,
} from '../../domain/repositories/delivery-job.repository';
import {
  DRIVER_PROFILE_REPOSITORY,
  IDriverProfileRepository,
} from '../../domain/repositories/driver-profile.repository';
import { isTrackableStatus } from '../../domain/services/tracking-policy';
import { GeoPoint } from '../../domain/value-objects/geo-point.vo';
import {
  ILocationCachePort,
  LOCATION_CACHE_PORT,
} from '../ports/outbound/location-cache.port';
import { IRealtimePort, REALTIME_PORT, TrackingUpdate } from '../ports/outbound/realtime.port';
import { EtaService, EtaView } from '../services/eta.service';

/** The dotted config key backing the durable write throttle. */
export const LOCATION_WRITE_INTERVAL_CONFIG_KEY = 'delivery.locationWriteIntervalSeconds';

export interface PublishJobLocationInput {
  /** Module 01 `users.id` of the posting driver — resolved from the token, never from the body. */
  userId: string;
  /** The job the position is being reported against. */
  jobId: string;
  lat: number;
  lng: number;
  /**
   * When the fix was taken on the handset, not when it arrived. Defaults to now for a client that
   * does not report one — but a buffered client must always report one, because it is the only
   * thing that distinguishes a replayed five-minute-old point from a fresh one (NFR-LOC-04).
   */
  recordedAt?: Date;
}

export interface PublishJobLocationResult {
  /** `false` when the report was no newer than one already seen, and was therefore ignored. */
  accepted: boolean;
  /** Whether this fix was written through to Postgres, or coalesced away by the throttle. */
  persisted: boolean;
  /**
   * Whether the fan-out actually entered the transport.
   *
   * `false` means subscribers did **not** receive it. Reported rather than hidden: a driver's app
   * being told its position was relayed when Redis was down would be a lie the customer pays for.
   */
  published: boolean;
  /** The position now considered current for this job — this fix, or the one that beat it. */
  location: { lat: number; lng: number; recordedAt: Date };
  status: DeliveryJobStatus;
}

/**
 * `PublishJobLocation` (§3.4 F-TRK-01, §7, BR-DEL-05, NFR-PERF-04, NFR-LOC-04) — a driver reports
 * where they are on a job they are carrying, and every subscribed customer sees it.
 *
 * ## The six steps, and where each one's authority lives
 *
 * 1. **Authenticated driver** — the gateway and the controller both resolve `userId` from the
 *    access token before this command is reached. No caller path accepts a driver id.
 * 2. **They are *this job's* driver** — `delivery_jobs.assigned_driver_id` must equal their
 *    profile id. A mismatch answers `NOT_FOUND`, never `FORBIDDEN`, so job ids cannot be probed
 *    to learn who is carrying what (`00-shared-conventions.md` §1).
 * 3. **The job is in a state where a position means something** — `TrackingPolicy`, which derives
 *    its list from `ACTIVE_JOB_STATUSES` rather than restating it.
 * 4. **The coordinates and timestamp are valid** — `GeoPoint` for range, and the driver-profile
 *    aggregate's own `recordLocation` for clock skew, which is the Work 03 rule reused rather
 *    than a second copy of it.
 * 5. **The durable last-known position is updated**, throttled — see below.
 * 6. **The update is fanned out**, unthrottled.
 *
 * ## Throttled to Postgres, unthrottled to the customer
 *
 * These are deliberately different cadences, and conflating them is the mistake this design
 * exists to avoid. §7 says location "is not persisted per-tick... to avoid write amplification",
 * while NFR-PERF-04 wants the customer's map moving within ten seconds. Both are satisfied by
 * throttling only the write: **every accepted fix is published**, and the durable row advances at
 * most once per `delivery.locationWriteIntervalSeconds`.
 *
 * The throttle is derived from the stored fix's own timestamp rather than from a counter, a timer
 * or a per-process memo. That matters for a reason specific to this platform's shape: with
 * several API nodes accepting posts there is no process that sees all of a driver's traffic, so
 * any in-memory throttle would be per-node and would multiply by the node count. Comparing
 * against the column makes the cadence a property of the data, correct on one node and on twenty.
 *
 * The cost is bounded and worth stating: the durable position trails the live one by at most the
 * interval plus one posting period. It is read by a *reconnecting* customer and by anything later
 * that asks where a driver was — never by the live map, which is fed by the fan-out.
 *
 * ## Nothing here is audited, and that is the same decision Work 03 made
 *
 * No audit row, no `delivery_status_history` row, no outbox event, no `Serializable` transaction.
 * The ETA service added alongside them writes nothing either — it reads a cache and a routing
 * port.
 * A position report is telemetry, not an operational decision: §13 audits decisions, and writing
 * an audit entry per driver per few seconds would bury the availability and status changes an
 * investigation actually reads under a flood of coordinates. It also means a duplicate or
 * replayed report is structurally incapable of creating a duplicate history or audit entry —
 * there is nothing for it to duplicate.
 *
 * ## Ordering: forwards only, at three separate points
 *
 * A handset that buffers while offline and flushes on reconnect will deliver points out of order
 * as a matter of routine (NFR-LOC-04). An older fix must never move the driver backwards on a
 * customer's map, so it is refused here — checked against the newest timestamp *either* store has
 * seen, because the throttle deliberately leaves the durable one behind — and the durable write
 * is independently monotonic by compare-and-set, which is what settles two fixes that interleave
 * across nodes after this check has passed.
 *
 * A stale report is **ignored, not rejected**: it comes back `accepted: false` with the position
 * that beat it, because a well-behaved client retrying a request that can never succeed would be
 * worse than the lost fix. A malformed one — a coordinate out of range, a timestamp far ahead of
 * the server's clock — is a client defect and does throw.
 */
@Injectable()
export class PublishJobLocationCommand {
  constructor(
    @Inject(DELIVERY_JOB_REPOSITORY) private readonly jobs: IDeliveryJobRepository,
    @Inject(DRIVER_PROFILE_REPOSITORY) private readonly profiles: IDriverProfileRepository,
    @Inject(LOCATION_CACHE_PORT) private readonly cache: ILocationCachePort,
    @Inject(REALTIME_PORT) private readonly realtime: IRealtimePort,
    @Inject(CONFIG_PORT) private readonly config: IConfigPort,
    private readonly eta: EtaService,
  ) {}

  async execute(input: PublishJobLocationInput): Promise<PublishJobLocationResult> {
    const userId = requireText(input.userId, 'userId');
    const jobId = requireText(input.jobId, 'jobId');
    const now = new Date();

    const profile = await this.profiles.findByUserId(userId);
    if (!profile) {
      throw DeliveryErrors.driverProfileNotFound({ userId });
    }

    const job = await this.jobs.findById(jobId);
    // Step 2. Both "no such job" and "somebody else's job" answer identically — the job id is not
    // an oracle. Note the check is against the *profile resolved from the token*, so a driver
    // cannot name a job by supplying the driver id that holds it.
    if (!job || job.assignedDriverId !== profile.id) {
      throw DeliveryErrors.notFound('Delivery job not found.', { jobId });
    }

    // Step 3. Terminal and pre-assignment states accept nothing: there is no delivery in progress
    // to have a position, and continuing to relay a driver's coordinates after `DELIVERED` would
    // be tracking a person rather than a parcel.
    if (!isTrackableStatus(job.status)) {
      throw DeliveryErrors.locationNotAcceptable(jobId, job.status);
    }

    // Step 4. Range from the value object; clock skew from the Work 03 aggregate rule. Both throw.
    const point = GeoPoint.of(input.lat, input.lng);
    const recordedAt = input.recordedAt ?? now;
    const entity = DriverProfile.rehydrate(profile);
    const advanced = entity.recordLocation(point, recordedAt);

    // Ordering. `recordLocation` returning the same instance means "no newer than the durable
    // one"; the cache covers the window the write throttle leaves uncovered, during which the
    // durable timestamp is deliberately behind the newest fix actually seen.
    // A cache entry left behind by a previous driver says nothing about whether *this* driver's
    // fix is stale, so it is discarded rather than compared against.
    const cachedAny = await this.cache.get(jobId);
    const cached = cachedAny !== null && cachedAny.driverId === profile.id ? cachedAny : null;
    const staleAgainstDurable = advanced === entity;
    const staleAgainstCache =
      cached !== null && recordedAt.getTime() <= cached.recordedAt.getTime();
    if (staleAgainstDurable || staleAgainstCache) {
      const current = newestOf(cached, profile.lastLocation, profile.lastLocationAt);
      return {
        accepted: false,
        persisted: false,
        published: false,
        location: current ?? { lat: point.lat, lng: point.lng, recordedAt },
        status: job.status,
      };
    }

    // Step 5, throttled. The comparison is against the stored fix's timestamp, so the cadence is a
    // property of the row rather than of whichever process happens to receive the post.
    const persisted = await this.persistIfDue(profile.id, profile.lastLocationAt, {
      lat: point.lat,
      lng: point.lng,
      recordedAt,
    });

    // The hot entry is refreshed on **every** accepted fix, including the ones the throttle
    // coalesced away — it is what makes the ordering check above see the newest point rather than
    // the last persisted one, and what lets a subscriber's initial snapshot be current.
    await this.cache.set(jobId, {
      lat: point.lat,
      lng: point.lng,
      recordedAt,
      driverId: profile.id,
    });

    // The estimate that travels with this fix, recalculated because a fresh position is exactly
    // the event that can change it (§5). `EtaService` decides whether the move was material enough
    // to be worth a routing call, so a stationary driver's fixes cost a cache read and nothing
    // more. It answers `null` rather than throwing on any failure, so nothing here can stop the
    // position going out.
    const eta = await this.eta.estimate(
      {
        jobId,
        status: job.status,
        pickupPoint: job.pickupPoint,
        dropoffPoint: job.dropoffPoint,
      },
      { lat: point.lat, lng: point.lng, recordedAt },
      now,
    );

    // Step 6. Never throws: the durable write has already happened and a fan-out failure must not
    // undo it, fail the request, or be reported as a success.
    const published = await this.realtime.publish(
      jobId,
      this.updateFor(job, point, recordedAt, now, eta),
    );

    return {
      accepted: true,
      persisted,
      published,
      location: { lat: point.lat, lng: point.lng, recordedAt },
      status: job.status,
    };
  }

  /**
   * Writes through to Postgres only when the stored fix is at least one interval old.
   *
   * A profile with no position yet always writes, so a driver's first fix of a shift is durable
   * immediately rather than after an interval of invisibility.
   */
  private async persistIfDue(
    profileId: string,
    storedAt: Date | null,
    update: { lat: number; lng: number; recordedAt: Date },
  ): Promise<boolean> {
    const intervalMs = this.writeIntervalSeconds() * 1_000;
    const due =
      storedAt === null || update.recordedAt.getTime() - storedAt.getTime() >= intervalMs;
    if (!due) {
      return false;
    }

    const written = await this.profiles.updateLocation(profileId, update);
    if (!written) {
      // The profile was removed between the read and the write.
      throw DeliveryErrors.driverProfileNotFound({ profileId });
    }
    // `updateLocation` is monotonic and returns what is *now* stored, which may be a newer fix
    // that won the race. Report persistence honestly rather than assuming this call is the winner.
    return written.lastLocationAt !== null &&
      written.lastLocationAt.getTime() === update.recordedAt.getTime();
  }

  private updateFor(
    job: { id: string; orderId: string; fulfillmentId: string; status: DeliveryJobStatus },
    point: GeoPoint,
    recordedAt: Date,
    now: Date,
    eta: EtaView | null,
  ): TrackingUpdate {
    return {
      jobId: job.id,
      orderId: job.orderId,
      fulfillmentId: job.fulfillmentId,
      lat: point.lat,
      lng: point.lng,
      recordedAt: recordedAt.toISOString(),
      receivedAt: now.toISOString(),
      status: job.status,
      eta:
        eta === null
          ? null
          : {
              destination: eta.destination,
              distanceMeters: eta.distanceMeters,
              durationSeconds: eta.durationSeconds,
              expectedArrivalAt: eta.expectedArrivalAt.toISOString(),
            },
    };
  }

  private writeIntervalSeconds(): number {
    const configured = this.config.get<number>(LOCATION_WRITE_INTERVAL_CONFIG_KEY);
    return typeof configured === 'number' &&
      Number.isInteger(configured) &&
      configured >= MIN_DELIVERY_LOCATION_WRITE_INTERVAL_SECONDS &&
      configured <= MAX_DELIVERY_LOCATION_WRITE_INTERVAL_SECONDS
      ? configured
      : DEFAULT_DELIVERY_LOCATION_WRITE_INTERVAL_SECONDS;
  }
}

/** The newer of the hot entry and the durable one, or `null` when neither holds a position. */
function newestOf(
  cached: { lat: number; lng: number; recordedAt: Date } | null,
  durablePoint: GeoPoint | null,
  durableAt: Date | null,
): { lat: number; lng: number; recordedAt: Date } | null {
  const durable =
    durablePoint !== null && durableAt !== null
      ? { lat: durablePoint.lat, lng: durablePoint.lng, recordedAt: durableAt }
      : null;
  if (cached === null) {
    return durable;
  }
  if (durable === null) {
    return cached;
  }
  return cached.recordedAt.getTime() >= durable.recordedAt.getTime() ? cached : durable;
}

function requireText(value: string, field: string): string {
  const text = (value ?? '').trim();
  if (!text) {
    throw DeliveryErrors.validation(`${field} is required.`, { field });
  }
  return text;
}
