import { Injectable } from '@nestjs/common';
import { ProductStatus } from '../../../domain/enums';
import { ChangeProductStatusCommand } from '../../commands/change-product-status.command';
import { ProductDetailView } from '../../queries/product-view';

export const CATALOG_REVIEW_SUBMISSION_PORT = Symbol('CATALOG_REVIEW_SUBMISSION_PORT');

/**
 * The submitted product, as Module 03's own status route returns it (`ProductDetailView`: the
 * catalogue record without `createdBy`). Re-exported so a consumer depends on this file only.
 */
export type SubmittedProductView = ProductDetailView;

export interface SubmitProductInput {
  /** From the verified access token, never from a request body. */
  actorUserId: string;
  productId: string;
}

/**
 * Module 03's exported contract for **submitting a draft product for catalogue review** (module-16
 * Work 29), consumed in-process by Module 16. One operation: `DRAFT -> PENDING_REVIEW`, and nothing
 * else — no target status is accepted, so a submission can never skip the review.
 *
 * Not a second status writer: it is `ChangeProductStatusCommand` with `expectedFrom: DRAFT` — the
 * same state machine, Serializable transaction, `PRODUCT_STATUS_CHANGED` audit entry and
 * `catalog.product.status_changed` outbox event, with the precondition enforced by the UPDATE
 * itself. Errors are Module 03's: unknown or deleted → `NOT_FOUND`; not `DRAFT` (or changed by a
 * concurrent request) → `CONFLICT`.
 *
 * Who may submit: whoever may manage catalogue products, `catalog:manage:any` — Module 03 has no
 * per-product ownership and no non-administrator product creation (`ProductProposal` is unused,
 * `catalog:manage:org` guards no route), so every curator manages every product, as on its other
 * admin routes. Authorization is the caller's.
 */
export interface ICatalogReviewSubmissionPort {
  submitDraftForReview(input: SubmitProductInput): Promise<SubmittedProductView>;
}

/** `ICatalogReviewSubmissionPort` over Module 03's own status command. */
@Injectable()
export class CatalogReviewSubmissionPortAdapter implements ICatalogReviewSubmissionPort {
  constructor(private readonly changeStatus: ChangeProductStatusCommand) {}

  submitDraftForReview(input: SubmitProductInput): Promise<SubmittedProductView> {
    return this.changeStatus.execute({
      actorUserId: input.actorUserId,
      productId: input.productId,
      status: ProductStatus.PENDING_REVIEW,
      expectedFrom: ProductStatus.DRAFT,
    });
  }
}
