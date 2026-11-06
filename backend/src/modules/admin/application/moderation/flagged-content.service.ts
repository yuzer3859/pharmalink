import { Inject, Injectable } from '@nestjs/common';
import { DisputeType } from '@prisma/client';
import {
  CATALOG_ADMIN_READ_PORT,
  ICatalogAdminReadPort,
  ProductStatus,
} from '../../../catalog/application/ports/inbound/catalog-admin-read.port';
import {
  IReviewModerationPort,
  REVIEW_MODERATION_PORT,
} from '../../../reviews/application/ports/inbound/review-moderation.port';
import { DisputeService } from '../disputes/dispute.service';

/** How many of each source the overview lists; each source has its own full queue. */
export const FLAGGED_PER_SOURCE = 20;

export type FlaggedSource = 'REVIEW' | 'CATALOG_PRODUCT' | 'CONTENT_DISPUTE';

export interface FlaggedItem {
  source: FlaggedSource;
  id: string;
  /** One line a moderator can act on. */
  summary: string;
  /** Why it is here: report reasons and automatic rules, a pending review, or a complaint. */
  reasons: string[];
  status: string;
  since: Date;
  /** Where the full item is handled. */
  route: string;
}

export interface FlaggedContentView {
  totals: Record<FlaggedSource, number>;
  items: FlaggedItem[];
}

const clip = (s: string | null | undefined, n = 80) => {
  const t = (s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/**
 * The unified flagged-content view (Work 91, module-16 F-AD-11, FR-ADM-11): everything awaiting a
 * content decision, from its owner, in one list.
 *
 *   - REVIEW: reviews held by reports or automatic rules (Module 15, `REVIEW_MODERATION_PORT`);
 *   - CATALOG_PRODUCT: products submitted for catalogue review (Module 03, `CATALOG_ADMIN_READ_PORT`);
 *   - CONTENT_DISPUTE: open disputes about content (Admin's own, Work 86).
 *
 * Read-only: each item links to the queue where its owner acts on it. Oldest first.
 */
@Injectable()
export class FlaggedContentService {
  constructor(
    @Inject(REVIEW_MODERATION_PORT) private readonly reviews: IReviewModerationPort,
    @Inject(CATALOG_ADMIN_READ_PORT) private readonly catalog: ICatalogAdminReadPort,
    private readonly disputes: DisputeService,
  ) {}

  async overview(): Promise<FlaggedContentView> {
    const [reviews, products, disputes] = await Promise.all([
      this.reviews.list({ needsAttention: true }, 1, FLAGGED_PER_SOURCE),
      this.catalog.listProducts({ status: ProductStatus.PENDING_REVIEW }, 1, FLAGGED_PER_SOURCE),
      this.disputes.list({ type: DisputeType.CONTENT, openOnly: true }, 1, FLAGGED_PER_SOURCE),
    ]);
    const items: FlaggedItem[] = [
      ...reviews.items.map((r) => ({
        source: 'REVIEW' as const,
        id: r.reviewId,
        summary: `${r.rating}★ ${clip(r.title || r.body) || '(no text)'}`,
        reasons: [...r.reportReasons, ...r.autoFlags.map((f) => `AUTO_${f}`)],
        status: r.status,
        since: r.updatedAt,
        route: `/admin/reviews/${r.reviewId}`,
      })),
      ...products.items.map((p) => ({
        source: 'CATALOG_PRODUCT' as const,
        id: p.id,
        summary: clip(p.brandName || p.genericName || p.nameEn || p.id),
        reasons: ['PENDING_REVIEW'],
        status: p.status,
        since: p.updatedAt,
        route: `/admin/catalog/products?status=PENDING_REVIEW`,
      })),
      ...disputes.items.map(({ case: d, overdue }) => ({
        source: 'CONTENT_DISPUTE' as const,
        id: d.id,
        summary: `${d.caseNumber} ${clip(d.subject)}`,
        reasons: [overdue ? 'OVERDUE' : d.priority],
        status: d.status,
        since: d.openedAt,
        route: `/admin/disputes/${d.id}`,
      })),
    ].sort((a, b) => +a.since - +b.since);
    return { totals: { REVIEW: reviews.total, CATALOG_PRODUCT: products.total, CONTENT_DISPUTE: disputes.total }, items };
  }
}
