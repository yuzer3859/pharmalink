import { Inject, Injectable } from '@nestjs/common';
import { AUDIT_READ_PORT, AuditRecordView, IAuditReadPort } from '../../../../../shared/audit/audit-read.port';
import { PRODUCT_AUDIT_RESOURCE_TYPE, PRODUCT_STATUS_CHANGED_ACTION } from '../../../domain/audit-actions';
import { ProductStatus } from '../../../domain/enums';
import { IProductRepository, PRODUCT_REPOSITORY } from '../../../domain/repositories/product.repository';

export const CATALOG_REVIEW_HISTORY_PORT = Symbol('CATALOG_REVIEW_HISTORY_PORT');

/**
 * One recorded status change of a product — read back from its `PRODUCT_STATUS_CHANGED` audit entry,
 * never inferred. `from` / `to` are as recorded (`null` only if an entry does not carry them).
 * `reason` is the validated rejection reason for a change **to `REJECTED`**, and `null` for every
 * other change: other changes may carry an operator's free-text note, which is not part of the review
 * record. Nothing else of the audit entry — actor, IP, hash chain, other context — is carried.
 */
export interface ProductStatusChangeView {
  from: string | null;
  to: string | null;
  occurredAt: Date;
  reason: string | null;
}

export interface ProductStatusHistoryView {
  productId: string;
  /** Oldest first. Empty when the product has never changed status. */
  history: ProductStatusChangeView[];
}

/**
 * Module 03's exported, read-only contract for **a product's status-change history** (module-16 Work
 * 33), consumed in-process by Module 16's catalogue review. Module 03 wrote these entries, so Module
 * 03 is the one that reads their context; it reads them through the shared `AUDIT_READ_PORT`
 * (`trailOf`: this product, this action, oldest first) — no second audit store, nothing written.
 *
 * `null` for an unknown or soft-deleted product, which a caller answers `404`.
 */
export interface ICatalogReviewHistoryPort {
  historyOf(productId: string): Promise<ProductStatusHistoryView | null>;
}

const text = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/** Only the approved fields of one entry's context; anything else in it is dropped. */
export function toProductStatusChange(entry: AuditRecordView): ProductStatusChangeView {
  const ctx = entry.context && typeof entry.context === 'object' ? (entry.context as Record<string, unknown>) : {};
  const to = text(ctx.to);
  return {
    from: text(ctx.from),
    to,
    occurredAt: entry.createdAt,
    reason: to === ProductStatus.REJECTED ? text(ctx.reason) : null,
  };
}

/** `ICatalogReviewHistoryPort` over Module 03's product repository and the shared audit read port. */
@Injectable()
export class CatalogReviewHistoryPortAdapter implements ICatalogReviewHistoryPort {
  constructor(
    @Inject(PRODUCT_REPOSITORY) private readonly products: IProductRepository,
    @Inject(AUDIT_READ_PORT) private readonly audit: IAuditReadPort,
  ) {}

  async historyOf(productId: string): Promise<ProductStatusHistoryView | null> {
    const product = await this.products.findById(productId);
    if (!product || product.deletedAt) return null;
    const entries = await this.audit.trailOf({
      action: PRODUCT_STATUS_CHANGED_ACTION,
      resourceType: PRODUCT_AUDIT_RESOURCE_TYPE,
      resourceId: productId,
    });
    return { productId, history: entries.map(toProductStatusChange) };
  }
}
