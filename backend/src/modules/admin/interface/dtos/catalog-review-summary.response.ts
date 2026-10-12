import { CatalogReviewSummary } from '../../application/queries/get-catalog-review-summary.query';

/** The catalogue review summary — aggregate counts and one timestamp; nothing per product. */
export interface CatalogReviewSummaryResponse {
  generatedAt: string;
  queue: {
    pendingReviewCount: number;
    pendingWithoutRecordedSubmission: number;
    oldestPendingSubmittedAt: string | null;
    oldestPendingAgeSeconds: number | null;
  };
  lifetimeTransitions: { approvals: number; rejections: number; resubmissions: number };
}

// Explicit allow-list, never a spread.
export function toCatalogReviewSummaryResponse(s: CatalogReviewSummary): CatalogReviewSummaryResponse {
  return {
    generatedAt: s.generatedAt.toISOString(),
    queue: {
      pendingReviewCount: s.queue.pendingReviewCount,
      pendingWithoutRecordedSubmission: s.queue.pendingWithoutRecordedSubmission,
      oldestPendingSubmittedAt: s.queue.oldestPendingSubmittedAt ? s.queue.oldestPendingSubmittedAt.toISOString() : null,
      oldestPendingAgeSeconds: s.queue.oldestPendingAgeSeconds,
    },
    lifetimeTransitions: {
      approvals: s.lifetimeTransitions.approvals,
      rejections: s.lifetimeTransitions.rejections,
      resubmissions: s.lifetimeTransitions.resubmissions,
    },
  };
}
