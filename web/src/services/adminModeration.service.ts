import { authService, type SessionRequest } from './auth.service';
import { toQuery } from './adminFinance.service';

export type ReviewStatus = 'PENDING' | 'PUBLISHED' | 'REJECTED' | 'FLAGGED' | 'REMOVED' | 'HIDDEN';
export type ModerationMove = 'hide' | 'remove' | 'restore';
export type FlaggedSource = 'REVIEW' | 'CATALOG_PRODUCT' | 'CONTENT_DISPUTE';

export interface ModerationReview {
  reviewId: string;
  authorUserId: string;
  targetType: string;
  targetId: string;
  orderId: string;
  rating: number;
  title: string | null;
  body: string | null;
  status: ReviewStatus;
  openReportCount: number;
  reportReasons: string[];
  autoFlags: string[];
  createdAt: string;
  updatedAt: string;
}

export interface FlaggedItem {
  source: FlaggedSource;
  id: string;
  summary: string;
  reasons: string[];
  status: string;
  since: string;
  route: string;
}

/** The moves the server allows from each status (Module 15, BRULE-46). */
export const MOVES_FROM: Record<ModerationMove, ReviewStatus[]> = {
  hide: ['PUBLISHED', 'FLAGGED'],
  remove: ['PUBLISHED', 'FLAGGED', 'HIDDEN'],
  restore: ['FLAGGED', 'HIDDEN'],
};

export const movesFor = (status: ReviewStatus): ModerationMove[] => (Object.keys(MOVES_FROM) as ModerationMove[]).filter((m) => MOVES_FROM[m].includes(status));

export const SOURCE_LABELS: Record<FlaggedSource, string> = {
  REVIEW: 'Review',
  CATALOG_PRODUCT: 'Catalogue product',
  CONTENT_DISPUTE: 'Content dispute',
};

/** Where each flagged item is handled in the portal. */
export const portalPathFor = (item: Pick<FlaggedItem, 'source'>) =>
  item.source === 'REVIEW' ? 'moderation' : item.source === 'CATALOG_PRODUCT' ? 'catalog-review' : 'disputes';

export function createAdminModerationService(request: SessionRequest) {
  return {
    /** `GET /admin/moderation/flagged`: everything awaiting a content decision, oldest first. */
    flagged(): Promise<{ totals: Record<FlaggedSource, number>; items: FlaggedItem[] }> {
      return request('/admin/moderation/flagged', { method: 'GET' });
    },
    reviews(filter: { status?: ReviewStatus | 'all'; needsAttention?: boolean; page?: number; size?: number } = {}): Promise<{ items: ModerationReview[]; total: number; page: number; size: number }> {
      return request(`/admin/reviews${toQuery({ status: filter.status, needsAttention: filter.needsAttention ? 'true' : undefined, page: filter.page, size: filter.size })}`, { method: 'GET' });
    },
    moderate(id: string, move: ModerationMove, reason: string): Promise<ModerationReview> {
      return request(`/admin/reviews/${encodeURIComponent(id)}/${move}`, { method: 'POST', body: { reason: reason.trim() } });
    },
  };
}

export const adminModerationService = createAdminModerationService(authService.request);
