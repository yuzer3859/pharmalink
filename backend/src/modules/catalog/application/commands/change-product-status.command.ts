import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../../../shared/audit/audit.service';
import { OutboxService } from '../../../../shared/outbox/outbox.service';
import { ProductStatus } from '../../domain/enums';
import { CatalogErrors } from '../../domain/errors';
import { PRODUCT_AUDIT_RESOURCE_TYPE, PRODUCT_STATUS_CHANGED_ACTION } from '../../domain/audit-actions';
import { productStatusChangedEvent } from '../../domain/events';
import { ProductStatusPolicy } from '../../domain/services/product-status-policy';
import { PRODUCT_REPOSITORY, IProductRepository } from '../../domain/repositories/product.repository';
import { UNIT_OF_WORK, IUnitOfWork } from '../ports/unit-of-work.port';
import { ProductDetailView, toProductDetailView } from '../queries/product-view';
import { CATEGORY_REPOSITORY, ICategoryRepository } from '../../domain/repositories/category.repository';
import { runWithDedupRetry } from '../support/dedup-conflict';

export interface ChangeProductStatusInput {
  actorUserId: string;
  productId: string;
  status: string;
  reason?: string;
  /**
   * When set, the change applies only to a product in exactly this status — checked in the
   * transaction and enforced again by the UPDATE itself (module-16 Work 28: approval requires
   * `PENDING_REVIEW`). Anything else is `productNotInExpectedStatus` (409), nothing written.
   */
  expectedFrom?: ProductStatus;
  /**
   * The change applies only from exactly this status, answered the state machine's way: any other
   * status is `INVALID_PRODUCT_STATUS_TRANSITION` (422) in the transaction, and the UPDATE itself
   * requires the status to still be this one. Used by catalogue-review rejection (module-16 Work 31,
   * from `PENDING_REVIEW`) and resubmission (Work 32, from `REJECTED` — where the policy alone would
   * also let a `DRAFT` move to `PENDING_REVIEW`).
   */
  requireFrom?: ProductStatus;
}

/**
 * `POST /admin/catalog/products/:id/status` (module-03 §8.2). State-machine-checked (§3.6
 * invariant 6, resolved §14.3: `DELISTED -> DRAFT` is legal, `DELISTED -> ACTIVE` never directly).
 */
@Injectable()
export class ChangeProductStatusCommand {
  constructor(
    @Inject(PRODUCT_REPOSITORY) private readonly products: IProductRepository,
    @Inject(CATEGORY_REPOSITORY) private readonly categories: ICategoryRepository,
    @Inject(UNIT_OF_WORK) private readonly uow: IUnitOfWork,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  async execute(input: ChangeProductStatusInput): Promise<ProductDetailView> {
    // ADR-010: the status change, audit entry and outbox event all commit atomically in this one
    // transaction, run at Serializable isolation to keep the audit hash chain fork-safe;
    // `runWithDedupRetry` retries on the resulting write-conflict rather than surfacing a 500.
    const product = await runWithDedupRetry(this.uow, async (tx) => {
      const found = await this.products.findById(input.productId, tx);
      if (!found || found.deletedAt) {
        throw CatalogErrors.notFound();
      }

      const from = found.status;
      if (input.expectedFrom && from !== input.expectedFrom) {
        throw CatalogErrors.productNotInExpectedStatus(input.expectedFrom, from);
      }
      if (input.requireFrom && from !== input.requireFrom) {
        throw CatalogErrors.invalidStatusTransition(from, input.status);
      }
      found.transitionStatus(input.status as ProductStatus);
      // A rejection must carry a valid reason (Work 31) — checked here, on every path.
      const reason = ProductStatusPolicy.reasonFor(found.status, input.reason);

      await this.products.save(found, tx, input.expectedFrom ?? input.requireFrom);

      await this.audit.record(
        {
          actorUserId: input.actorUserId,
          action: PRODUCT_STATUS_CHANGED_ACTION,
          resourceType: PRODUCT_AUDIT_RESOURCE_TYPE,
          resourceId: found.id,
          context: { from, to: found.status, reason },
        },
        tx,
      );

      await this.outbox.write(
        productStatusChangedEvent({
          productId: found.id,
          from,
          to: found.status,
          reason,
        }),
        tx as never,
      );

      return found;
    });

    const categoryIds = await this.products.categoryIdsFor(product.id);
    const categoryEntities = await this.categories.findManyByIds(categoryIds);
    return toProductDetailView(
      product,
      categoryEntities.map((c) => {
        const props = c.toProps();
        return { id: props.id, slug: props.slug, nameAm: props.nameAm, nameEn: props.nameEn };
      }),
    );
  }
}
