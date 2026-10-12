import { ProductStatusHistoryView } from '../../../catalog/application/ports/inbound/catalog-review-history.port';

/** One recorded status change: the transition, when, and — for a rejection only — its reason. */
export interface ProductStatusChangeResponse {
  from: string | null;
  to: string | null;
  occurredAt: string;
  reason: string | null;
}

export interface CatalogReviewHistoryResponse {
  productId: string;
  history: ProductStatusChangeResponse[];
}

// Explicit allow-list, never a spread: no actor, IP, hash or other audit context.
export function toCatalogReviewHistoryResponse(v: ProductStatusHistoryView): CatalogReviewHistoryResponse {
  return {
    productId: v.productId,
    history: v.history.map((h) => ({ from: h.from, to: h.to, occurredAt: h.occurredAt.toISOString(), reason: h.reason })),
  };
}
