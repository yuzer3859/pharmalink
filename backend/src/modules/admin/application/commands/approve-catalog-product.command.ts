import { Inject, Injectable } from '@nestjs/common';
import {
  ApprovedProductView,
  CATALOG_REVIEW_APPROVAL_PORT,
  ICatalogReviewApprovalPort,
} from '../../../catalog/application/ports/inbound/catalog-review-approval.port';

export interface ApproveCatalogProductInput {
  /** From the verified access token, never from a request body. */
  actorUserId: string;
  productId: string;
}

/**
 * `POST /admin/catalog/review/:productId/approve` (module-16 Work 28).
 *
 *     admin HTTP → PermissionsGuard(catalog:manage:any) → this command
 *       → ICatalogReviewApprovalPort.approvePendingProduct
 *       → Module 03: ChangeProductStatusCommand, PENDING_REVIEW → ACTIVE, guarded by the UPDATE
 *
 * The decision, its rule and its record are Module 03's: the state machine, the Serializable
 * transaction, the one `PRODUCT_STATUS_CHANGED` audit entry (actor = this administrator, context
 * `{ from: PENDING_REVIEW, to: ACTIVE }`) and the `catalog.product.status_changed` outbox event all
 * commit together there. This command adds no audit row of its own — a second row for the same
 * decision is exactly what Work 09 declined to write. Module 03's errors pass through unchanged:
 * unknown → 404, not `PENDING_REVIEW` (or approved concurrently) → 409.
 *
 * Limitation: nothing puts a product into `PENDING_REVIEW` yet (the submission workflow is a future
 * work), so through the normal lifecycle this has no product to approve.
 */
@Injectable()
export class ApproveCatalogProductCommand {
  constructor(@Inject(CATALOG_REVIEW_APPROVAL_PORT) private readonly approval: ICatalogReviewApprovalPort) {}

  execute(input: ApproveCatalogProductInput): Promise<ApprovedProductView> {
    return this.approval.approvePendingProduct({ actorUserId: input.actorUserId, productId: input.productId });
  }
}
