import type { ModerationMove } from '../../../domain/review-policy';

export const REVIEW_MODERATION_PORT = Symbol('REVIEW_MODERATION_PORT');

export type { ModerationMove } from '../../../domain/review-policy';
export { MODERATION_MOVES } from '../../../domain/review-policy';

export type ModeratedReviewStatus = 'PENDING' | 'PUBLISHED' | 'REJECTED' | 'FLAGGED' | 'REMOVED' | 'HIDDEN';

/** A review as a moderator sees it: content, author, the reports against it, and its log. */
export interface ModerationReviewView {
  reviewId: string;
  authorUserId: string;
  targetType: string;
  targetId: string;
  orderId: string;
  rating: number;
  title: string | null;
  body: string | null;
  status: ModeratedReviewStatus;
  openReportCount: number;
  reportReasons: string[];
  /** The automatic rules it tripped, from its moderation log. */
  autoFlags: string[];
  createdAt: Date;
  updatedAt: Date;
}

export interface ModerationLogView {
  action: string;
  reason: string | null;
  isAutomated: boolean;
  moderatorUserId: string | null;
  createdAt: Date;
}

export interface ModerationSearch {
  status?: ModeratedReviewStatus;
  /** Only reviews with unresolved reports or held by an automatic rule (the moderation queue). */
  needsAttention?: boolean;
}

/**
 * Module 15's inbound contract for Module 16's moderation desk (Work 91, BRULE-46, FR-ADM-11). Admin
 * reads and moderates reviews only through it; the status change, the moderation log, the rating
 * aggregate and the author's notice all happen inside Module 15.
 */
export interface IReviewModerationPort {
  list(filter: ModerationSearch, page: number, size: number): Promise<{ items: ModerationReviewView[]; total: number }>;
  get(reviewId: string): Promise<{ review: ModerationReviewView; log: ModerationLogView[] } | null>;
  moderate(input: { reviewId: string; move: ModerationMove; reason: string; moderatorUserId: string; ip?: string | null }): Promise<ModerationReviewView>;
}
