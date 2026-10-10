import { Inject, Injectable } from '@nestjs/common';
import {
  CATALOG_REVIEW_SUBMISSION_PORT,
  ICatalogReviewSubmissionPort,
  SubmittedProductView,
} from '../../../catalog/application/ports/inbound/catalog-review-submission.port';

export interface SubmitCatalogProductInput {
  /** From the verified access token, never from a request body. */
  actorUserId: string;
  productId: string;
}

/**
 * `POST /admin/catalog/review/:productId/submit` (module-16 Work 29) — puts a draft product into
 * catalogue review, where Work 28's approval takes it.
 *
 *     admin HTTP → PermissionsGuard(catalog:manage:any) → this command
 *       → ICatalogReviewSubmissionPort.submitDraftForReview
 *       → Module 03: ChangeProductStatusCommand, DRAFT → PENDING_REVIEW, guarded by the UPDATE
 *
 * As with approval, the rule and its record are Module 03's: one `PRODUCT_STATUS_CHANGED` audit
 * entry (`{ from: DRAFT, to: PENDING_REVIEW }`) and one `catalog.product.status_changed` outbox
 * event, in the status change's own transaction. No audit row of Module 16's own. Errors pass
 * through: unknown → 404, not `DRAFT` (or submitted concurrently) → 409.
 *
 * The submitter is a catalogue curator (`catalog:manage:any`): Module 03 creates products only on its
 * admin route and has no per-product ownership, so there is no other actor who could submit.
 */
@Injectable()
export class SubmitCatalogProductCommand {
  constructor(@Inject(CATALOG_REVIEW_SUBMISSION_PORT) private readonly submission: ICatalogReviewSubmissionPort) {}

  execute(input: SubmitCatalogProductInput): Promise<SubmittedProductView> {
    return this.submission.submitDraftForReview({ actorUserId: input.actorUserId, productId: input.productId });
  }
}
