import { Inject, Injectable } from '@nestjs/common';
import { DeliveryJobProps } from '../../domain/entities/delivery-job.entity';
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
import {
  IJobOfferRepository,
  JOB_OFFER_REPOSITORY,
} from '../../domain/repositories/job-offer.repository';
import { JobOfferProps } from '../../domain/entities/job-offer.entity';
import { ACTIVE_JOB_STATUSES } from '../../domain/services/driver-availability-policy';

/** The largest page a driver's handset may ask for. */
export const MAX_DRIVER_JOB_PAGE_SIZE = 50;

/**
 * The most live offers reported alongside the list.
 *
 * Not a page — offers are not paginated, because a driver with more pending offers than this has a
 * dispatch problem, not a paging problem. The cap exists so that a bug elsewhere cannot turn this
 * read into an unbounded one.
 */
export const MAX_DRIVER_PENDING_OFFERS = 20;

/**
 * The statuses a driver's own list may show, and the **only** ones it can ever show.
 *
 * `ACTIVE_JOB_STATUSES` is the span in which a driver is responsible for a job — the same set
 * BRULE-28's concurrent-job count is derived from — plus the two states that answer "what did I
 * just finish?" A driver who completes a delivery and pulls to refresh should still see it; one
 * whose job was reassigned away should not, and does not, because `REASSIGNING` clears
 * `assignedDriverId` and the row stops matching them at all.
 *
 * `OFFERED` is deliberately absent **from this set**, and it is not an omission — the design's
 * "active + offered" is served by the view's separate `offers` section instead. The reason is that
 * a job in `OFFERED` has `assignedDriverId` null, so it could not be attributed to a driver by this
 * filter even if it belonged in it. Who was asked lives in `job_offers`, which is where the offers
 * half reads from, and reading it there also means an offer past its deadline is never shown.
 */
export const DRIVER_VISIBLE_STATUSES: readonly DeliveryJobStatus[] = [
  ...ACTIVE_JOB_STATUSES,
  DeliveryJobStatus.DELIVERED,
  DeliveryJobStatus.COMPLETED,
];

export interface ListDriverJobsInput {
  /** From the access token. There is no route parameter and no query parameter for it. */
  userId: string;
  /**
   * Narrows the list to one status. Refused unless it is already in `DRIVER_VISIBLE_STATUSES` —
   * a filter may subtract from the allow-list, never add to it.
   */
  status?: DeliveryJobStatus;
  page?: number;
  size?: number;
}

/** A live offer, paired with the job it is about. */
export interface DriverOfferView {
  offer: JobOfferProps;
  job: DeliveryJobProps;
}

export interface DriverJobsPageView {
  /**
   * Jobs this driver is **carrying**. Paginated.
   */
  items: DeliveryJobProps[];
  /**
   * Jobs this driver has been **offered** and has not yet answered, soonest deadline first.
   *
   * Separate from `items` rather than merged into one list, because the two are different things
   * and a driver acts on them differently: an offer is a question with a deadline that expires if
   * ignored, a job is work already owned. Merging them would also make pagination incoherent —
   * page two of a union whose first half is re-evaluated against the clock on every request.
   *
   * Unaffected by `status` and by paging, for the same reason: filtering "my assigned jobs" has no
   * meaning for a question nobody has answered yet.
   */
  offers: DriverOfferView[];
  total: number;
  page: number;
  size: number;
}

/**
 * `GET /driver/jobs` — what the authenticated driver is carrying, and what they have been offered
 * (§9.1's "active + offered jobs", deferred until this work).
 *
 * ## Scoping, and why it cannot be widened
 *
 * The driver is resolved from `userId` to a `driver_profiles.id` here, and that id is the only
 * value ever placed in `assignedDriverId`. There is no input field through which a caller could
 * name a different driver: `ListDriverJobsInput` has no `driverId`, the DTO has no `driverId`, and
 * the controller passes the token's subject. A driver who has no profile at all gets
 * `DRIVER_PROFILE_NOT_FOUND` rather than an unfiltered page — the failure direction matters, and
 * "no profile" must never fall through to "no filter".
 *
 * The status filter is validated against the allow-list rather than passed through, so the widest
 * possible answer to any request is still this driver's own jobs in the visible states.
 *
 * ## What the caller gets, and what it does not
 *
 * The job rows themselves and the driver's live offers, both of which the response DTO narrows
 * again. Nothing else is joined in:
 *
 *  - **No earnings.** `DriverEarning` is its own aggregate behind `delivery:earnings:own` and
 *    `GET /delivery/earnings`; a driver reading their job list is not asking what they were paid,
 *    and folding it in would put a money read behind a permission that does not mention money.
 *  - **No proof-of-delivery artifacts.** Private, and served by their own authorized read.
 *  - **No COD reconciliation detail.** A driver sees what they collected through the COD read;
 *    remittance and reconciliation are finance's, behind finance's permissions.
 *  - **No other driver's anything.** There is no shape in which another driver's row could be
 *    selected, because the `where` clause names this driver's profile id unconditionally.
 */
@Injectable()
export class ListDriverJobsQuery {
  constructor(
    @Inject(DELIVERY_JOB_REPOSITORY) private readonly jobs: IDeliveryJobRepository,
    @Inject(DRIVER_PROFILE_REPOSITORY) private readonly profiles: IDriverProfileRepository,
    @Inject(JOB_OFFER_REPOSITORY) private readonly offers: IJobOfferRepository,
  ) {}

  async execute(input: ListDriverJobsInput): Promise<DriverJobsPageView> {
    const userId = (input.userId ?? '').trim();
    if (!userId) {
      throw DeliveryErrors.validation('userId is required.', { field: 'userId' });
    }

    const profile = await this.profiles.findByUserId(userId);
    if (!profile) {
      throw DeliveryErrors.driverProfileNotFound({ userId });
    }

    if (input.status !== undefined && !DRIVER_VISIBLE_STATUSES.includes(input.status)) {
      throw DeliveryErrors.validation(
        'status must be one of the driver-visible delivery states.',
        { field: 'status', allowed: [...DRIVER_VISIBLE_STATUSES] },
      );
    }

    const page = Math.max(1, Math.trunc(input.page ?? 1));
    const size = Math.min(MAX_DRIVER_JOB_PAGE_SIZE, Math.max(1, Math.trunc(input.size ?? 20)));

    const result = await this.jobs.list({
      assignedDriverId: profile.id,
      statuses: [...DRIVER_VISIBLE_STATUSES],
      status: input.status,
      page,
      size,
    });

    return {
      items: result.items,
      offers: await this.pendingOffers(profile.id),
      total: result.total,
      page,
      size,
    };
  }

  /**
   * The driver's live offers, each resolved to the job it names.
   *
   * An offer whose job has vanished is skipped rather than reported with a null job: the two are
   * written in one transaction, so this can only be a row that a later migration or a manual
   * intervention left behind, and a handset is not the place to surface that.
   */
  private async pendingOffers(driverProfileId: string): Promise<DriverOfferView[]> {
    const pending = await this.offers.listPendingForDriver(
      driverProfileId,
      new Date(),
      MAX_DRIVER_PENDING_OFFERS,
    );

    const views: DriverOfferView[] = [];
    for (const offer of pending) {
      const job = await this.jobs.findById(offer.jobId);
      if (job) {
        views.push({ offer, job });
      }
    }
    return views;
  }
}
