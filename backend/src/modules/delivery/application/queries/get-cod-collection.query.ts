import { Inject, Injectable } from '@nestjs/common';
import {
  CodCollectionProps,
  hasDiscrepancy,
  varianceOf,
} from '../../domain/entities/cod-collection.entity';
import { DeliveryErrors } from '../../domain/errors';
import {
  COD_COLLECTION_REPOSITORY,
  ICodCollectionRepository,
} from '../../domain/repositories/cod-collection.repository';
import {
  DELIVERY_JOB_REPOSITORY,
  IDeliveryJobRepository,
} from '../../domain/repositories/delivery-job.repository';
import {
  DRIVER_PROFILE_REPOSITORY,
  IDriverProfileRepository,
} from '../../domain/repositories/driver-profile.repository';
import { CodCollectionPolicy } from '../../domain/services/cod-collection-policy';

/** What a driver is told about the cash they recorded taking. */
export interface CodCollectionView {
  collection: CodCollectionProps;
  /** `collectedAmount − expectedAmount`. Positive is an overpayment, negative a shortfall. */
  variance: number;
  /** Whether the two amounts disagree at all. */
  hasDiscrepancy: boolean;
  /** Whether this collection could be reconciled as it stands. Never true with a discrepancy. */
  isReconcilable: boolean;
  /**
   * Whether PharmaLink currently has an open question about this collection (§12).
   *
   * A boolean, and **only** a boolean. The driver whose cash is being queried has a real interest
   * in knowing that it is — finding out weeks later from a deduction nobody explained is the
   * failure this prevents — but the reason, the operator who raised it, the note and every
   * correction stay on the finance surface. Publishing an investigation's contents to its subject
   * is a different decision, and one nobody has taken.
   */
  hasOpenDispute: boolean;
}

/**
 * The authorized read of one delivery's COD collection (§17, F-COD-01).
 *
 * ## Scope is resolved, never accepted
 *
 * The caller's `users.id` becomes a `driver_profiles.id` here, and the job must currently name that
 * profile. No method accepts a driver id. A job that is not the caller's — and a job whose
 * collection has not been recorded — answer `NOT_FOUND` identically, so job ids cannot be probed
 * for whether somebody else collected cash for them.
 *
 * ## Why the customer is not a viewer
 *
 * `DeliveryAccessService` lets the owning customer read tracking and proof of delivery, because
 * both answer "what is happening to my order". This read does not: it answers "what is this driver
 * holding and has the platform reconciled it", which is an operational and financial question
 * between the platform and its collection channel. A customer who wants to know what they paid
 * reads their order from Module 06, which is the module that charged them.
 *
 * Nor is there a finance or administrative view here — that lives behind `finance:report:any` on
 * `/admin/delivery/cod-reconciliation`, where the corrections and disputes are also readable in
 * full. This read deliberately carries neither: a driver sees `hasOpenDispute` and nothing else
 * about it, and no correction at all. A driver may not approve a correction, alter an amount,
 * resolve their own dispute or mark a reconciliation complete, and the way that is guaranteed is
 * that none of those exists anywhere a `delivery:*:own` permission can reach.
 *
 * ## It reports what was declared, and says so
 *
 * The view carries both amounts, the signed variance, and whether the collection could be
 * reconciled as it stands. It does not report that the money has been received by PharmaLink or
 * paid to the pharmacy, because this module knows neither — `status` says exactly how far the cash
 * has got, and `COLLECTED` means a driver said they took it.
 */
@Injectable()
export class GetCodCollectionQuery {
  constructor(
    @Inject(COD_COLLECTION_REPOSITORY) private readonly collections: ICodCollectionRepository,
    @Inject(DRIVER_PROFILE_REPOSITORY) private readonly profiles: IDriverProfileRepository,
    @Inject(DELIVERY_JOB_REPOSITORY) private readonly jobs: IDeliveryJobRepository,
  ) {}

  async byJobId(jobId: string, userId: string): Promise<CodCollectionView> {
    const id = requireText(jobId, 'jobId');
    const profile = await this.profiles.findByUserId(requireText(userId, 'userId'));
    if (!profile) {
      throw DeliveryErrors.driverProfileNotFound({ userId });
    }

    const job = await this.jobs.findById(id);
    if (!job || job.assignedDriverId !== profile.id) {
      throw notFound(id);
    }

    const collection = await this.collections.findByJobId(id);
    if (!collection || collection.driverId !== profile.id) {
      throw notFound(id);
    }

    return {
      collection,
      variance: varianceOf(collection),
      hasDiscrepancy: hasDiscrepancy(collection),
      isReconcilable: CodCollectionPolicy.isReconcilable(collection),
      // Keyed by the **collection**, not by `id` — which is the job. One extra indexed read on the
      // partial unique index, and the answer is a boolean before it ever leaves this method, so
      // there is no path by which the dispute's contents could reach a driver's response.
      hasOpenDispute: (await this.collections.findOpenDispute(collection.id)) !== null,
    };
  }
}

/** The one answer an unauthorized, absent or not-yet-recorded subject ever gets. */
function notFound(jobId: string) {
  return DeliveryErrors.notFound('COD collection not found.', { jobId });
}

function requireText(value: string, field: string): string {
  const text = (value ?? '').trim();
  if (!text) {
    throw DeliveryErrors.validation(`${field} is required.`, { field });
  }
  return text;
}
