import { Inject, Injectable } from '@nestjs/common';
import {
  CATALOG_REVIEW_RESUBMISSION_PORT,
  ICatalogReviewResubmissionPort,
  ResubmittedProductView,
} from '../../../catalog/application/ports/inbound/catalog-review-resubmission.port';

export interface ResubmitCatalogProductInput {
  /** From the verified access token, never from a request body. */
  actorUserId: string;
  productId: string;
}

/**
 * `POST /admin/catalog/review/:productId/resubmit` (module-16 Work 32) — puts a rejected, corrected
 * product back under catalogue review, where Work 28's approval or Work 31's rejection decides again.
 *
 *     admin HTTP → PermissionsGuard(catalog:manage:any) → this command
 *       → ICatalogReviewResubmissionPort.resubmitRejectedProduct
 *       → Module 03: ChangeProductStatusCommand, REJECTED → PENDING_REVIEW, guarded by the UPDATE
 *
 * The rule and its record are Module 03's: one `PRODUCT_STATUS_CHANGED` audit entry and one
 * `catalog.product.status_changed` outbox event (`{ from: REJECTED, to: PENDING_REVIEW }`), in the
 * status change's own transaction. No audit row of Module 16's own. Errors pass through: unknown →
 * 404; any status but `REJECTED` (or resubmitted concurrently) → 422 `INVALID_PRODUCT_STATUS_TRANSITION`.
 */
@Injectable()
export class ResubmitCatalogProductCommand {
  constructor(@Inject(CATALOG_REVIEW_RESUBMISSION_PORT) private readonly resubmission: ICatalogReviewResubmissionPort) {}

  execute(input: ResubmitCatalogProductInput): Promise<ResubmittedProductView> {
    return this.resubmission.resubmitRejectedProduct({ actorUserId: input.actorUserId, productId: input.productId });
  }
}
