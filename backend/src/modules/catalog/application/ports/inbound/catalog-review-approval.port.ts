import { Injectable } from '@nestjs/common';
import { ProductStatus } from '../../../domain/enums';
import { ChangeProductStatusCommand } from '../../commands/change-product-status.command';
import { ProductDetailView } from '../../queries/product-view';

export const CATALOG_REVIEW_APPROVAL_PORT = Symbol('CATALOG_REVIEW_APPROVAL_PORT');

/**
 * The approved product, as Module 03's own status route returns it (`ProductDetailView`: the
 * catalogue record without `createdBy`). Re-exported so a consumer depends on this file only.
 */
export type ApprovedProductView = ProductDetailView;

export interface ApproveProductInput {
  /** From the verified access token, never from a request body. */
  actorUserId: string;
  productId: string;
}

/**
 * Module 03's exported contract for **approving a product under catalogue review** (module-16 Work
 * 28), consumed in-process by Module 16. One operation: `PENDING_REVIEW -> ACTIVE`, and nothing
 * else — a product in any other status is refused even where `-> ACTIVE` would be legal from it
 * (`DRAFT`, `DEPRECATED`), because this is the review decision, not a general status change.
 *
 * Not a second status writer: it is `ChangeProductStatusCommand` with `expectedFrom:
 * PENDING_REVIEW` — the same state machine, Serializable transaction, `PRODUCT_STATUS_CHANGED`
 * audit entry and `catalog.product.status_changed` outbox event, with the precondition enforced by
 * the UPDATE itself. Errors are Module 03's: unknown or deleted → `NOT_FOUND`; not `PENDING_REVIEW`
 * (or changed by a concurrent request) → `CONFLICT`.
 *
 * A product reaches `PENDING_REVIEW` through the submission port (`ICatalogReviewSubmissionPort`,
 * module-16 Work 29): create (DRAFT) → submit → approve.
 */
export interface ICatalogReviewApprovalPort {
  approvePendingProduct(input: ApproveProductInput): Promise<ApprovedProductView>;
}

/** `ICatalogReviewApprovalPort` over Module 03's own status command. */
@Injectable()
export class CatalogReviewApprovalPortAdapter implements ICatalogReviewApprovalPort {
  constructor(private readonly changeStatus: ChangeProductStatusCommand) {}

  approvePendingProduct(input: ApproveProductInput): Promise<ApprovedProductView> {
    return this.changeStatus.execute({
      actorUserId: input.actorUserId,
      productId: input.productId,
      status: ProductStatus.ACTIVE,
      expectedFrom: ProductStatus.PENDING_REVIEW,
    });
  }
}
