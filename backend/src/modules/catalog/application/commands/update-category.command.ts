import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../../../shared/audit/audit.service';
import { OutboxService } from '../../../../shared/outbox/outbox.service';
import { CategoryEdits } from '../../domain/entities/category.entity';
import { CategoryAppliesTo } from '../../domain/enums';
import { CatalogErrors } from '../../domain/errors';
import { categoryUpdatedEvent } from '../../domain/events';
import { CategoryCycleGuard } from '../../domain/services/category-cycle';
import { CATEGORY_REPOSITORY, ICategoryRepository } from '../../domain/repositories/category.repository';
import { UNIT_OF_WORK, IUnitOfWork } from '../ports/unit-of-work.port';
import { CategoryView, toCategoryView } from '../queries/category-view';

export interface UpdateCategoryInput {
  actorUserId: string;
  categoryId: string;
  parentId?: string | null;
  nameAm?: string;
  nameEn?: string;
  appliesTo?: string;
  sortOrder?: number;
  isActive?: boolean;
}

/** `PATCH /admin/catalog/categories/:id` (module-03 §8.2). `slug` is immutable, never accepted. */
@Injectable()
export class UpdateCategoryCommand {
  constructor(
    @Inject(CATEGORY_REPOSITORY) private readonly categories: ICategoryRepository,
    @Inject(UNIT_OF_WORK) private readonly uow: IUnitOfWork,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  async execute(input: UpdateCategoryInput): Promise<CategoryView> {
    const found = await this.categories.findById(input.categoryId);
    if (!found) {
      throw CatalogErrors.categoryNotFound();
    }

    if (input.parentId) {
      const parent = await this.categories.findById(input.parentId);
      if (!parent) {
        throw CatalogErrors.categoryNotFound();
      }
      const parentChain = await this.categories.getAncestorChain(input.parentId);
      CategoryCycleGuard.assertNoCycle(found.id, parentChain);
    }

    const edits: CategoryEdits = {
      parentId: input.parentId,
      nameAm: input.nameAm,
      nameEn: input.nameEn,
      appliesTo: input.appliesTo as CategoryAppliesTo | undefined,
      sortOrder: input.sortOrder,
      isActive: input.isActive,
    };
    const changedFields = found.applyEdits(edits);

    // ADR-010: save, audit entry and outbox event commit atomically in this one transaction.
    await this.uow.run(async (tx) => {
      await this.categories.save(found, tx);
      await this.audit.record(
        {
          actorUserId: input.actorUserId,
          action: 'CATEGORY_UPDATED',
          resourceType: 'Category',
          resourceId: found.id,
          context: { fields: changedFields },
        },
        tx,
      );
      await this.outbox.write(
        categoryUpdatedEvent({ categoryId: found.id, fields: changedFields }),
        tx as never,
      );
    });

    return toCategoryView(found);
  }
}
