import { Inject, Injectable } from '@nestjs/common';
import { DriverEarningProps } from '../../domain/entities/driver-earning.entity';
import { DeliveryErrors } from '../../domain/errors';
import {
  DELIVERY_JOB_REPOSITORY,
  IDeliveryJobRepository,
} from '../../domain/repositories/delivery-job.repository';
import {
  DRIVER_EARNING_REPOSITORY,
  IDriverEarningRepository,
} from '../../domain/repositories/driver-earning.repository';
import {
  DRIVER_PROFILE_REPOSITORY,
  IDriverProfileRepository,
} from '../../domain/repositories/driver-profile.repository';

export const MAX_EARNINGS_PAGE_SIZE = 100;
export const DEFAULT_EARNINGS_PAGE_SIZE = 20;

/** A driver's ledger page, with the summary a driver actually opens the screen for. */
export interface DriverEarningsView {
  items: DriverEarningProps[];
  total: number;
  limit: number;
  offset: number;
  /**
   * The sum of the **returned page**, not of the ledger.
   *
   * Stated explicitly because the alternative is worse in a way that would not be obvious: a
   * lifetime total computed here would be a money figure produced by a delivery module outside any
   * settlement boundary, and a driver comparing it against what Module 07 actually paid them would
   * have two numbers with no defined relationship. A page sum is arithmetic on what is on screen.
   */
  pageTotal: number;
  currency: string;
}

/**
 * `GetEarnings` (§9.2's `GET /driver/earnings`, §10's `queries/`, F-ERN-02) — a driver's own
 * earnings ledger, and the per-delivery read behind it.
 *
 * ## Scope is resolved, never accepted
 *
 * Both methods take the authenticated `users.id` and resolve it to a `driver_profiles.id` here.
 * No method on this query accepts a driver id, and `IDriverEarningRepository.listByDriver` puts
 * that resolved id in the SQL `where` clause — so there is no path through this query, or through
 * the repository beneath it, that returns another driver's earnings (§13).
 *
 * A driver with no operational profile gets `DRIVER_PROFILE_NOT_FOUND` rather than an empty list:
 * an empty ledger and "you are not a driver on this platform" are different answers, and quietly
 * conflating them would hide a misconfigured account behind a plausible-looking screen.
 *
 * ## Reading one delivery's earning
 *
 * `byJobId` is scoped the same way and adds one rule: the caller must be the driver the job was
 * assigned to. A job that is not theirs — or that has no earning yet — answers `NOT_FOUND`
 * identically, so job ids cannot be probed for whether somebody else was paid for them.
 *
 * **The customer is deliberately not a viewer here**, which is the one place this read departs from
 * `DeliveryAccessService`'s tracking and proof-of-delivery rules. Those answer "what is happening
 * to my order", and a customer is entitled to that. What a driver is paid is not a fact about the
 * customer's order; it is a fact about the platform's arrangement with the driver, and the
 * delivery-quote work already stated the same boundary in the other direction when it kept driver
 * earnings out of the customer's fee breakdown.
 *
 * ## It is a read of what was accrued, not of what was paid
 *
 * Nothing here consults Module 07, and the `status` a caller sees is whatever the ledger row holds
 * — `ACCRUED` for everything Delivery writes. A driver asking "have I been paid?" is asking Module
 * 07 a question this module cannot answer, and answering it approximately would be worse than not
 * answering it.
 */
@Injectable()
export class GetDriverEarningsQuery {
  constructor(
    @Inject(DRIVER_EARNING_REPOSITORY) private readonly earnings: IDriverEarningRepository,
    @Inject(DRIVER_PROFILE_REPOSITORY) private readonly profiles: IDriverProfileRepository,
    @Inject(DELIVERY_JOB_REPOSITORY) private readonly jobs: IDeliveryJobRepository,
  ) {}

  /** The authenticated driver's own ledger, newest first. */
  async forDriver(
    userId: string,
    paging: { limit?: number; offset?: number } = {},
  ): Promise<DriverEarningsView> {
    const driverId = await this.resolveDriverId(userId);
    const limit = clampLimit(paging.limit);
    const offset = clampOffset(paging.offset);

    const page = await this.earnings.listByDriver({ driverId, limit, offset });

    return {
      items: page.items,
      total: page.total,
      limit,
      offset,
      // Integer addition over minor units (ADR-005) — no float touches a money total.
      pageTotal: page.items.reduce((sum, earning) => sum + earning.total, 0),
      currency: page.items[0]?.currency ?? 'ETB',
    };
  }

  /** The earning for one of the driver's own deliveries. */
  async byJobId(jobId: string, userId: string): Promise<DriverEarningProps> {
    const driverId = await this.resolveDriverId(userId);
    const id = requireText(jobId, 'jobId');

    const job = await this.jobs.findById(id);
    if (!job || job.assignedDriverId !== driverId) {
      // One answer for "no such job", "not your job" and — below — "not accrued yet". A driver
      // must not be able to learn from this route that somebody else was paid for a delivery.
      throw notFound(id);
    }

    const earning = await this.earnings.findByJobId(id);
    if (!earning || earning.driverId !== driverId) {
      throw notFound(id);
    }
    return earning;
  }

  /**
   * The authenticated user's operational driver id.
   *
   * The single place a `users.id` becomes a `driver_profiles.id` on this path, so the scope every
   * read below applies comes from the token and from nowhere else.
   */
  private async resolveDriverId(userId: string): Promise<string> {
    const profile = await this.profiles.findByUserId(requireText(userId, 'userId'));
    if (!profile) {
      throw DeliveryErrors.driverProfileNotFound({ userId });
    }
    return profile.id;
  }
}

function notFound(jobId: string) {
  return DeliveryErrors.notFound('Delivery earning not found.', { jobId });
}

function clampLimit(limit?: number): number {
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1) {
    return DEFAULT_EARNINGS_PAGE_SIZE;
  }
  return Math.min(limit, MAX_EARNINGS_PAGE_SIZE);
}

function clampOffset(offset?: number): number {
  if (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0) {
    return 0;
  }
  return offset;
}

function requireText(value: string, field: string): string {
  const text = (value ?? '').trim();
  if (!text) {
    throw DeliveryErrors.validation(`${field} is required.`, { field });
  }
  return text;
}
