import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../../../shared/audit/audit.service';
import { OutboxService } from '../../../../shared/outbox/outbox.service';
import { ProductStatus } from '../../domain/enums';
import { CatalogErrors } from '../../domain/errors';
import { productStatusChangedEvent } from '../../domain/events';
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
      found.transitionStatus(input.status as ProductStatus);

      await this.products.save(found, tx);

      await this.audit.record(
        {
          actorUserId: input.actorUserId,
          action: 'PRODUCT_STATUS_CHANGED',
          resourceType: 'Product',
          resourceId: found.id,
          context: { from, to: found.status, reason: input.reason ?? null },
        },
        tx,
      );

      await this.outbox.write(
        productStatusChangedEvent({
          productId: found.id,
          from,
          to: found.status,
          reason: input.reason ?? null,
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
