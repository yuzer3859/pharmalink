import { Inject, Injectable } from '@nestjs/common';
import {
  CATALOG_REVIEW_SUMMARY_READ_PORT,
  ICatalogReviewSummaryReadPort,
} from '../../../catalog/application/ports/inbound/catalog-review-summary-read.port';

/**
 * The catalogue review summary (module-16 Work 34) — Module 03's aggregates, plus the one figure that
 * depends on the clock: the oldest wait's age, in whole seconds to `generatedAt`, never negative,
 * `null` when nothing waits (or no waiting product has a recorded entry into review). See
 * `CatalogReviewSummaryView` for every definition.
 */
export interface CatalogReviewSummary {
  generatedAt: Date;
  queue: {
    pendingReviewCount: number;
    pendingWithoutRecordedSubmission: number;
    oldestPendingSubmittedAt: Date | null;
    oldestPendingAgeSeconds: number | null;
  };
  lifetimeTransitions: { approvals: number; rejections: number; resubmissions: number };
}

export const ageSecondsBetween = (from: Date | null, to: Date): number | null =>
  from ? Math.max(0, Math.floor((+to - +from) / 1000)) : null;

/**
 * `GET /admin/catalog/review/summary` (module-16 Work 34), over Module 03's
 * `CATALOG_REVIEW_SUMMARY_READ_PORT`. Read-only; not audited.
 */
@Injectable()
export class GetCatalogReviewSummaryQuery {
  constructor(@Inject(CATALOG_REVIEW_SUMMARY_READ_PORT) private readonly review: ICatalogReviewSummaryReadPort) {}

  async execute(): Promise<CatalogReviewSummary> {
    const s = await this.review.summarizeReview();
    // Stamped after the read, so the age is measured from data that already existed.
    const generatedAt = new Date();
    return {
      generatedAt,
      queue: {
        pendingReviewCount: s.pendingReviewCount,
        pendingWithoutRecordedSubmission: s.pendingWithoutRecordedSubmission,
        oldestPendingSubmittedAt: s.oldestPendingSubmittedAt,
        oldestPendingAgeSeconds: ageSecondsBetween(s.oldestPendingSubmittedAt, generatedAt),
      },
      lifetimeTransitions: { approvals: s.approvals, rejections: s.rejections, resubmissions: s.resubmissions },
    };
  }
}
