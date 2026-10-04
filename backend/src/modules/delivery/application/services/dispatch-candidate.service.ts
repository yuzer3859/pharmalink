import { Inject, Injectable } from '@nestjs/common';
import { CONFIG_PORT, IConfigPort } from '../../../../shared/config/config.port';
import { DEFAULT_DELIVERY_MAX_CONCURRENT_JOBS } from '../../../../shared/config/delivery.config';
import { DeliveryJobProps } from '../../domain/entities/delivery-job.entity';
import {
  DELIVERY_JOB_REPOSITORY,
  IDeliveryJobRepository,
} from '../../domain/repositories/delivery-job.repository';
import {
  DRIVER_PROFILE_REPOSITORY,
  IDriverProfileRepository,
} from '../../domain/repositories/driver-profile.repository';
import { DispatchCandidate, rankCandidates } from '../../domain/services/dispatch-policy';
import { IIdentityPort, IDENTITY_PORT } from '../ports/outbound/identity.port';
import { MAX_CONCURRENT_JOBS_CONFIG_KEY } from '../queries/get-driver-operational-status.query';

/**
 * How many online drivers are pulled into one ranking pass.
 *
 * A pool size, not a result size — the ranking picks one driver out of it. Two hundred is far
 * beyond the number of drivers who could plausibly be online and near one Addis pharmacy at one
 * moment, so in practice this bounds nothing; it exists so that the query has a ceiling on a day
 * when the platform is much larger than it is today. §14's geospatial index is what replaces this
 * with a genuine radius query rather than a bounded scan.
 */
export const DISPATCH_CANDIDATE_POOL_SIZE = 200;

/** A candidate that also passed the Module 01 verification gate. */
export interface EligibleDriver {
  candidate: DispatchCandidate;
  /** Rank within the pass, 1-based, for the audit trail. */
  rank: number;
  /** How many candidates the ranking produced before verification was applied. */
  rankedCount: number;
}

/**
 * Finds the driver a job should be offered to (§6.1–§6.2, F-JOB-03, BR-DEL-02).
 *
 * ## Why the Module 01 check comes last
 *
 * Eligibility has two halves with very different costs. The Delivery-owned half — online, on
 * shift, in service area, under the concurrent-job limit — is a pure function over rows this
 * module already has, and `DispatchPolicy.rankCandidates` applies it to the whole pool at once.
 * The Module 01 half — is this driver actually verified and allowed to operate (BRULE-09) — is a
 * live cross-context read, one per driver.
 *
 * So the ranking runs first and the verification walk second, down the ranked list, stopping at
 * the first driver who passes. The usual case is one identity read rather than one per online
 * driver, and the answer is identical to checking everybody: verification cannot promote a driver
 * up the ranking, only remove them from it.
 *
 * **Nothing about that result is cached or stored.** No `is_verified` column, no memoisation
 * across calls, no carrying an earlier answer into the accept path — the accept path asks again,
 * because the seconds between an offer and its acceptance are seconds in which an approval can be
 * revoked. `IIdentityPort` is the authority, every time it is consulted.
 *
 * ## Why the whole selection is re-run on every offer
 *
 * `findFor` takes a job and builds its candidate list from scratch. There is deliberately no
 * stored shortlist that a decline or an expiry walks down, and that is the point: between one
 * offer and the next a driver may have gone offline, ended their shift, lost verification,
 * accepted a different job and reached their limit, or driven out of the area. A cached list
 * would offer a job to a driver who can no longer take it, and the cost of finding that out is a
 * failed acceptance and a customer waiting another TTL.
 */
@Injectable()
export class DispatchCandidateService {
  constructor(
    @Inject(DRIVER_PROFILE_REPOSITORY) private readonly profiles: IDriverProfileRepository,
    @Inject(DELIVERY_JOB_REPOSITORY) private readonly jobs: IDeliveryJobRepository,
    @Inject(IDENTITY_PORT) private readonly identity: IIdentityPort,
    @Inject(CONFIG_PORT) private readonly config: IConfigPort,
  ) {}

  /**
   * The best eligible driver for this job, or `null` when there is none.
   *
   * `null` is an ordinary answer, not a failure: at three in the morning there may genuinely be
   * nobody online. The caller decides what that means for the job — see
   * `DispatchDeliveryJobCommand`, which leaves it dispatchable rather than failing it.
   */
  async findFor(
    job: DeliveryJobProps,
    excludedDriverIds: ReadonlySet<string>,
  ): Promise<EligibleDriver | null> {
    const pool = await this.profiles.findDispatchCandidates(DISPATCH_CANDIDATE_POOL_SIZE);
    if (pool.length === 0) {
      return null;
    }

    const activeJobCounts = await this.jobs.countActiveJobsByDriver(pool.map((d) => d.id));

    const ranked = rankCandidates(pool, {
      pickup: job.pickupPoint,
      platformConcurrentLimit: this.platformLimit(),
      activeJobCounts,
      // The job's current driver is always excluded on top of whatever the caller passes. A
      // reassignment clears `assignedDriverId` before dispatching again, so this catches the case
      // the caller forgot rather than the normal one — but "offered the job they are already
      // carrying" is a bad enough outcome to be worth the belt and braces.
      excludedDriverIds: withCurrentDriver(excludedDriverIds, job.assignedDriverId),
    });

    for (let index = 0; index < ranked.length; index += 1) {
      const candidate = ranked[index];
      const identity = await this.identity.getDriverIdentity(candidate.driver.userId);
      if (identity.isEligible) {
        return { candidate, rank: index + 1, rankedCount: ranked.length };
      }
    }

    return null;
  }

  /**
   * `delivery.maxConcurrentJobs`, with the same conservative fallback
   * `GetDriverOperationalStatusQuery` uses — a missing value must not resolve to `NaN` and make
   * `hasCapacity` false for every driver on the platform, which would silently stop all dispatch.
   */
  private platformLimit(): number {
    const configured = this.config.get<number>(MAX_CONCURRENT_JOBS_CONFIG_KEY);
    return typeof configured === 'number' && Number.isInteger(configured) && configured > 0
      ? configured
      : DEFAULT_DELIVERY_MAX_CONCURRENT_JOBS;
  }
}

function withCurrentDriver(
  excluded: ReadonlySet<string>,
  assignedDriverId: string | null,
): ReadonlySet<string> {
  if (assignedDriverId === null || excluded.has(assignedDriverId)) {
    return excluded;
  }
  return new Set([...excluded, assignedDriverId]);
}
