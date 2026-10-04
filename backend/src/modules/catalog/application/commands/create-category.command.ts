import { randomUUID } from 'crypto';
import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../../../shared/audit/audit.service';
import { ApiException } from '../../../../shared/errors/api-exception';
import { OutboxService } from '../../../../shared/outbox/outbox.service';
import { Category, NewCategoryProps } from '../../domain/entities/category.entity';
import { CategoryAppliesTo } from '../../domain/enums';
import { CatalogErrors } from '../../domain/errors';
import { categoryCreatedEvent } from '../../domain/events';
import { CategoryCycleGuard } from '../../domain/services/category-cycle';
import { CATEGORY_REPOSITORY, ICategoryRepository } from '../../domain/repositories/category.repository';
import { UNIT_OF_WORK, IUnitOfWork } from '../ports/unit-of-work.port';
import { CategoryView, toCategoryView } from '../queries/category-view';

export interface CreateCategoryInput {
  actorUserId: string;
  parentId?: string;
  slug: string;
  nameAm?: string;
  nameEn?: string;
  appliesTo?: string;
  sortOrder?: number;
}

/** `POST /admin/catalog/categories` (module-03 §8.2). */
@Injectable()
export class CreateCategoryCommand {
  constructor(
    @Inject(CATEGORY_REPOSITORY) private readonly categories: ICategoryRepository,
    @Inject(UNIT_OF_WORK) private readonly uow: IUnitOfWork,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  async execute(input: CreateCategoryInput): Promise<CategoryView> {
    const existingSlug = await this.categories.findBySlug(input.slug);
    if (existingSlug) {
      throw ApiException.conflict('A category with this slug already exists.', { field: 'slug' });
    }

    if (input.parentId) {
      const parent = await this.categories.findById(input.parentId);
      if (!parent) {
        throw CatalogErrors.categoryNotFound();
      }
      const parentChain = await this.categories.getAncestorChain(input.parentId);
      CategoryCycleGuard.assertNoCycle(undefined, parentChain);
    }

    const newProps: NewCategoryProps = {
      parentId: input.parentId ?? null,
      slug: input.slug,
      nameAm: input.nameAm,
      nameEn: input.nameEn,
      appliesTo: input.appliesTo as CategoryAppliesTo | undefined,
      sortOrder: input.sortOrder,
    };
    const created = Category.create(randomUUID(), newProps);

    // ADR-010: create, audit entry and outbox event commit atomically in this one transaction.
    await this.uow.run(async (tx) => {
      await this.categories.create(created, tx);
      await this.audit.record(
        {
          actorUserId: input.actorUserId,
          action: 'CATEGORY_CREATED',
          resourceType: 'Category',
          resourceId: created.id,
          context: { slug: input.slug },
        },
        tx,
      );
      await this.outbox.write(
        categoryCreatedEvent({ categoryId: created.id, slug: input.slug }),
        tx as never,
      );
    });

    return toCategoryView(created);
  }
}
