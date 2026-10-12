import { Injectable } from '@nestjs/common';
import { ProductStatus } from '../../../domain/enums';
import { REJECTION_REASON_MAX_LENGTH, REJECTION_REASON_MIN_LENGTH } from '../../../domain/services/product-status-policy';
import { ChangeProductStatusCommand } from '../../commands/change-product-status.command';
import { ProductDetailView } from '../../queries/product-view';

export const CATALOG_REVIEW_REJECTION_PORT = Symbol('CATALOG_REVIEW_REJECTION_PORT');

/** Module 03's limits for a rejection reason (trimmed length), re-exported for request validation. */
export { REJECTION_REASON_MAX_LENGTH, REJECTION_REASON_MIN_LENGTH };

/**
 * The rejected product, as Module 03's own status route returns it (`ProductDetailView`: the
 * catalogue record without `createdBy`, and without the rejection reason — that lives only in the
 * status change's audit entry and outbox event). Re-exported so a consumer depends on this file only.
 */
export type RejectedProductView = ProductDetailView;

export interface RejectProductInput {
  /** From the verified access token, never from a request body. */
  actorUserId: string;
  productId: string;
  reason: string;
}

/**
 * Module 03's exported contract for **rejecting a product under catalogue review** (module-16 Work
 * 31), consumed in-process by Module 16. One operation: `PENDING_REVIEW -> REJECTED`.
 *
 * Not a second status writer: it is `ChangeProductStatusCommand` — the same state machine,
 * Serializable transaction, `PRODUCT_STATUS_CHANGED` audit entry and `catalog.product.status_changed`
 * outbox event (both carrying the reason) — with the UPDATE guarded on `PENDING_REVIEW`. The reason
 * rule (trimmed, 3–300 characters) is `ProductStatusPolicy.reasonFor`'s, enforced inside that command
 * for every path. Errors are Module 03's: unknown or deleted → `NOT_FOUND`; any status but
 * `PENDING_REVIEW` → `INVALID_PRODUCT_STATUS_TRANSITION` (422); bad reason → `VALIDATION_ERROR`.
 */
export interface ICatalogReviewRejectionPort {
  rejectPendingProduct(input: RejectProductInput): Promise<RejectedProductView>;
}

/** `ICatalogReviewRejectionPort` over Module 03's own status command. */
@Injectable()
export class CatalogReviewRejectionPortAdapter implements ICatalogReviewRejectionPort {
  constructor(private readonly changeStatus: ChangeProductStatusCommand) {}

  rejectPendingProduct(input: RejectProductInput): Promise<RejectedProductView> {
    return this.changeStatus.execute({
      actorUserId: input.actorUserId,
      productId: input.productId,
      status: ProductStatus.REJECTED,
      reason: input.reason,
      requireFrom: ProductStatus.PENDING_REVIEW,
    });
  }
}
