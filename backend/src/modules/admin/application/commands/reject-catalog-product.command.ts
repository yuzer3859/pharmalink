import { Inject, Injectable } from '@nestjs/common';
import {
  CATALOG_REVIEW_REJECTION_PORT,
  ICatalogReviewRejectionPort,
  RejectedProductView,
} from '../../../catalog/application/ports/inbound/catalog-review-rejection.port';

export interface RejectCatalogProductInput {
  /** From the verified access token, never from a request body. */
  actorUserId: string;
  productId: string;
  reason: string;
}

/**
 * `POST /admin/catalog/review/:productId/reject` (module-16 Work 31).
 *
 *     admin HTTP → PermissionsGuard(catalog:manage:any) → this command
 *       → ICatalogReviewRejectionPort.rejectPendingProduct
 *       → Module 03: ChangeProductStatusCommand, PENDING_REVIEW → REJECTED, guarded by the UPDATE
 *
 * The rule and its record are Module 03's: one `PRODUCT_STATUS_CHANGED` audit entry and one
 * `catalog.product.status_changed` outbox event, both carrying `{ from: PENDING_REVIEW, to:
 * REJECTED, reason }`, in the status change's own transaction. No audit row of Module 16's own.
 * Errors pass through: unknown → 404; any other status (or rejected concurrently) → 422
 * `INVALID_PRODUCT_STATUS_TRANSITION`; a bad reason → 400.
 */
@Injectable()
export class RejectCatalogProductCommand {
  constructor(@Inject(CATALOG_REVIEW_REJECTION_PORT) private readonly rejection: ICatalogReviewRejectionPort) {}

  execute(input: RejectCatalogProductInput): Promise<RejectedProductView> {
    return this.rejection.rejectPendingProduct({ actorUserId: input.actorUserId, productId: input.productId, reason: input.reason });
  }
}
