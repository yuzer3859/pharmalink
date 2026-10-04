import { Inject, Injectable } from '@nestjs/common';
import { CONFIG_PORT, IConfigPort } from '../../../../shared/config/config.port';
import { DEFAULT_DELIVERY_MAX_CONCURRENT_JOBS } from '../../../../shared/config/delivery.config';
import { DriverAvailability } from '../../domain/enums';
import { DeliveryErrors } from '../../domain/errors';
import {
  DELIVERY_JOB_REPOSITORY,
  IDeliveryJobRepository,
} from '../../domain/repositories/delivery-job.repository';
import {
  DRIVER_PROFILE_REPOSITORY,
  IDriverProfileRepository,
} from '../../domain/repositories/driver-profile.repository';
import {
  hasCapacity,
  isWorkingAvailability,
  resolveConcurrentLimit,
} from '../../domain/services/driver-availability-policy';

/** The config key `00-shared-conventions.md` §10 names for the concurrent-job limit. */
export const MAX_CONCURRENT_JOBS_CONFIG_KEY = 'delivery.maxConcurrentJobs';

export interface DriverCapacityView {
  /** Jobs the driver is holding right now, counted from `delivery_jobs` (never a stored counter). */
  activeJobCount: number;
  /** The effective limit: the per-driver override, or the platform default (BRULE-28). */
  limit: number;
  /** Whether the driver could take on one more job. */
  hasCapacity: boolean;
  /** `true` when `limit` came from `driver_profiles.max_concurrent` rather than config. */
  limitIsOverride: boolean;
}

export interface DriverOperationalStatusView {
  profileId: string;
  /** Module 01 `users.id`. */
  userId: string;
  availability: DriverAvailability;
  onShift: boolean;
  shiftStartedAt: Date | null;
  lastOnlineAt: Date | null;
  vehicleType: string | null;
  plateNumber: string | null;
  serviceArea: { lat: number; lng: number; radiusMeters: number } | null;
  lastLocation: { lat: number; lng: number; recordedAt: Date } | null;
  capacity: DriverCapacityView;
  /**
   * Whether the driver is in a state where dispatch could offer them work **on Delivery's side
   * alone** — working, and under their limit.
   *
   * Deliberately *not* the whole eligibility answer. BRULE-09's verification is Module 01's and is
   * read live at the moment it matters; folding it in here would turn this read into an
   * authorization decision, and a stale copy of one at that. Dispatch checks both, and this field
   * is the half Module 08 owns.
   */
  dispatchableByDeliveryState: boolean;
}

/**
 * `GetDriverOperationalStatus` (§3.1, §9.1's `GET /driver/profile`) — the driver's whole
 * operational state in one read, **including the concurrent-job capacity the dispatch work will
 * consume**.
 *
 * ## The capacity answer, assembled from three sources
 *
 * `activeJobCount` is counted from `delivery_jobs` over the states in which a driver is actually
 * holding a job (`DriverAvailabilityPolicy.ACTIVE_JOB_STATUSES`), never read from a stored
 * counter — the Phase-0 `active_job_count` column is dropped by this work, for the reason ADR-006
 * gives about mutable counters guarding a limit.
 *
 * `limit` is the per-driver override if there is one, and `delivery.maxConcurrentJobs` otherwise
 * (§3.1 F-DRV-04's "configurable"). The two are reported separately from the verdict because an
 * operator asking why a driver is getting no work needs to see *which* limit applied and where it
 * came from, not just that it was reached.
 *
 * ## Why a query and not a guard
 *
 * Nothing refuses an assignment yet, because nothing assigns yet. This work provides the
 * capability the accept path (§11.2) will call and stops there — the refusal, its
 * `CONCURRENT_LIMIT_REACHED` error code, and the transactional check that makes it race-free all
 * belong with the command that assigns, because that command is what has to hold the two
 * operations together. A limit enforced in a read is not enforced.
 */
@Injectable()
export class GetDriverOperationalStatusQuery {
  constructor(
    @Inject(DRIVER_PROFILE_REPOSITORY) private readonly profiles: IDriverProfileRepository,
    @Inject(DELIVERY_JOB_REPOSITORY) private readonly jobs: IDeliveryJobRepository,
    @Inject(CONFIG_PORT) private readonly config: IConfigPort,
  ) {}

  async byUserId(userId: string): Promise<DriverOperationalStatusView> {
    const profile = await this.profiles.findByUserId(requireText(userId, 'userId'));
    if (!profile) {
      throw DeliveryErrors.driverProfileNotFound({ userId });
    }

    const activeJobCount = await this.jobs.countActiveJobs(profile.id);
    const platformDefault = this.platformLimit();
    const limit = resolveConcurrentLimit(profile.maxConcurrent, platformDefault);

    return {
      profileId: profile.id,
      userId: profile.userId,
      availability: profile.availability,
      onShift: profile.shiftStartedAt !== null,
      shiftStartedAt: profile.shiftStartedAt,
      lastOnlineAt: profile.lastOnlineAt,
      vehicleType: profile.vehicle?.type ?? null,
      plateNumber: profile.vehicle?.plateNumber ?? null,
      serviceArea: profile.serviceArea?.toJson() ?? null,
      lastLocation:
        profile.lastLocation && profile.lastLocationAt
          ? {
              lat: profile.lastLocation.lat,
              lng: profile.lastLocation.lng,
              recordedAt: profile.lastLocationAt,
            }
          : null,
      capacity: {
        activeJobCount,
        limit,
        hasCapacity: hasCapacity(activeJobCount, limit),
        // True only when the stored override is what actually won. A stored value the policy
        // rejected (see `resolveConcurrentLimit`) falls through to the platform limit and is
        // reported as such, rather than claiming an override that had no effect.
        limitIsOverride: profile.maxConcurrent !== null && profile.maxConcurrent === limit,
      },
      dispatchableByDeliveryState:
        isWorkingAvailability(profile.availability) && hasCapacity(activeJobCount, limit),
    };
  }

  /**
   * Reads `delivery.maxConcurrentJobs`, falling back to the registered default.
   *
   * The fallback is not dead code even though `delivery.config.ts` now registers the key: a
   * future `IConfigPort` implementation — Module 16's DB-backed one — can return nothing, and a
   * missing limit must degrade to the conservative default rather than crash a driver's profile
   * read or, worse, resolve to `NaN` and let `hasCapacity` return false for everyone.
   */
  private platformLimit(): number {
    const configured = this.config.get<number>(MAX_CONCURRENT_JOBS_CONFIG_KEY);
    return typeof configured === 'number' && Number.isInteger(configured) && configured > 0
      ? configured
      : DEFAULT_DELIVERY_MAX_CONCURRENT_JOBS;
  }
}

function requireText(value: string, field: string): string {
  const text = (value ?? '').trim();
  if (!text) {
    throw DeliveryErrors.validation(`${field} is required.`, { field });
  }
  return text;
}
