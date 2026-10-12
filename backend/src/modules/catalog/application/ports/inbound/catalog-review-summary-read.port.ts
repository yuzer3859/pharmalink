export const CATALOG_REVIEW_SUMMARY_READ_PORT = Symbol('CATALOG_REVIEW_SUMMARY_READ_PORT');

/**
 * The catalogue review queue and its recorded decisions, aggregated (module-16 Work 34). Counts and
 * one timestamp — no product, actor, reason or audit entry.
 *
 * Current queue — live products (`deletedAt IS NULL`) whose status is `PENDING_REVIEW` now:
 *  - `pendingReviewCount` — how many.
 *  - `oldestPendingSubmittedAt` — for each of them, the **latest** `PRODUCT_STATUS_CHANGED` entry
 *    whose context records `to = PENDING_REVIEW` (a submission from `DRAFT` or a resubmission from
 *    `REJECTED`) is when its current wait began; this is the earliest of those, or `null`. So a product
 *    rejected and resubmitted is waiting since its resubmission, not its first submission.
 *  - `pendingWithoutRecordedSubmission` — pending products with no such entry at all. They are counted
 *    in `pendingReviewCount` but cannot age: no wait start is invented for them. (Through the
 *    application every entry into `PENDING_REVIEW` is recorded, so this is normally 0.)
 *
 * Lifetime decisions — every recorded `PRODUCT_STATUS_CHANGED` entry, deleted products included
 * (the decision happened); transitions, not distinct products:
 *  - `approvals` — `from = PENDING_REVIEW, to = ACTIVE` (not `DEPRECATED -> ACTIVE`).
 *  - `rejections` — `from = PENDING_REVIEW, to = REJECTED`.
 *  - `resubmissions` — `from = REJECTED, to = PENDING_REVIEW`.
 *  An entry whose context lacks a string `from`/`to` matches none of them.
 *
 * All of it from one database snapshot.
 */
export interface CatalogReviewSummaryView {
  pendingReviewCount: number;
  pendingWithoutRecordedSubmission: number;
  oldestPendingSubmittedAt: Date | null;
  approvals: number;
  rejections: number;
  resubmissions: number;
}

/**
 * Module 03's exported, read-only contract for the catalogue review summary (module-16 Work 34),
 * consumed in-process by Module 16. Module 03 wrote the status-change entries it aggregates; no
 * product id, entry or context leaves it. Separate from the per-product history port (Work 33).
 */
export interface ICatalogReviewSummaryReadPort {
  summarizeReview(): Promise<CatalogReviewSummaryView>;
}
