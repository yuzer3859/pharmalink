import { Injectable } from '@nestjs/common';
import { ProductStatus } from '../../../domain/enums';
import { ChangeProductStatusCommand } from '../../commands/change-product-status.command';
import { ProductDetailView } from '../../queries/product-view';

export const CATALOG_REVIEW_RESUBMISSION_PORT = Symbol('CATALOG_REVIEW_RESUBMISSION_PORT');

/**
 * The resubmitted product, as Module 03's own status route returns it (`ProductDetailView`: the
 * catalogue record without `createdBy`, and without any rejection reason). Re-exported so a consumer
 * depends on this file only.
 */
export type ResubmittedProductView = ProductDetailView;

export interface ResubmitProductInput {
  /** From the verified access token, never from a request body. */
  actorUserId: string;
  productId: string;
}

/**
 * Module 03's exported contract for **resubmitting a rejected product for catalogue review**
 * (module-16 Work 32), consumed in-process by Module 16. One operation: `REJECTED -> PENDING_REVIEW`.
 * It changes the status only — corrections are made beforehand through Module 03's existing
 * product update, which edits a product in any status, `REJECTED` included.
 *
 * Not a second status writer: it is `ChangeProductStatusCommand` with `requireFrom: REJECTED` — the
 * same state machine, Serializable transaction, `PRODUCT_STATUS_CHANGED` audit entry and
 * `catalog.product.status_changed` outbox event, with the UPDATE guarded on `REJECTED`. Errors are
 * Module 03's: unknown or deleted → `NOT_FOUND`; any status but `REJECTED` (a `DRAFT` included, though
 * `DRAFT -> PENDING_REVIEW` is legal — that is Work 29's submission) → `INVALID_PRODUCT_STATUS_TRANSITION`
 * (422). Back under review, never straight to `ACTIVE`: approval (Work 28) still decides.
 */
export interface ICatalogReviewResubmissionPort {
  resubmitRejectedProduct(input: ResubmitProductInput): Promise<ResubmittedProductView>;
}

/** `ICatalogReviewResubmissionPort` over Module 03's own status command. */
@Injectable()
export class CatalogReviewResubmissionPortAdapter implements ICatalogReviewResubmissionPort {
  constructor(private readonly changeStatus: ChangeProductStatusCommand) {}

  resubmitRejectedProduct(input: ResubmitProductInput): Promise<ResubmittedProductView> {
    return this.changeStatus.execute({
      actorUserId: input.actorUserId,
      productId: input.productId,
      status: ProductStatus.PENDING_REVIEW,
      requireFrom: ProductStatus.REJECTED,
    });
  }
}
