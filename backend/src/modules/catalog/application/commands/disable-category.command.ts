import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../../../shared/audit/audit.service';
import { OutboxService } from '../../../../shared/outbox/outbox.service';
import { CatalogErrors } from '../../domain/errors';
import { categoryUpdatedEvent } from '../../domain/events';
import { CATEGORY_REPOSITORY, ICategoryRepository } from '../../domain/repositories/category.repository';
import { PRODUCT_REPOSITORY, IProductRepository } from '../../domain/repositories/product.repository';
import { UNIT_OF_WORK, IUnitOfWork } from '../ports/unit-of-work.port';

export interface DisableCategoryInput {
  actorUserId: string;
  categoryId: string;
}

/**
 * `DELETE /admin/catalog/categories/:id` (module-03 §8.2) — a soft-disable (`isActive = false`),
 * never a hard delete (§3.6 invariant 7 posture). Blocked with `409 CATEGORY_HAS_PRODUCTS` if
 * active products still reference it (§11 edge case 9), mirroring Module 02's careful
 * default-address deletion sequencing rather than allowing dangling references.
 */
@Injectable()
export class DisableCategoryCommand {
  constructor(
    @Inject(CATEGORY_REPOSITORY) private readonly categories: ICategoryRepository,
    @Inject(PRODUCT_REPOSITORY) private readonly products: IProductRepository,
    @Inject(UNIT_OF_WORK) private readonly uow: IUnitOfWork,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  async execute(input: DisableCategoryInput): Promise<void> {
    const found = await this.categories.findById(input.categoryId);
    if (!found) {
      throw CatalogErrors.categoryNotFound();
    }

    const productCount = await this.products.countByCategoryId(input.categoryId);
    if (productCount > 0) {
      throw CatalogErrors.categoryHasProducts();
    }

    found.disable();

    // ADR-010: the disable, audit entry and outbox event commit atomically in this one transaction.
    await this.uow.run(async (tx) => {
      await this.categories.save(found, tx);
      await this.audit.record(
        {
          actorUserId: input.actorUserId,
          action: 'CATEGORY_DISABLED',
          resourceType: 'Category',
          resourceId: found.id,
          context: { slug: found.toProps().slug },
        },
        tx,
      );
      await this.outbox.write(
        categoryUpdatedEvent({ categoryId: found.id, fields: ['isActive'] }),
        tx as never,
      );
    });
  }
}
