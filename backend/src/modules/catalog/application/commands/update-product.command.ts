import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../../../shared/audit/audit.service';
import { OutboxService } from '../../../../shared/outbox/outbox.service';
import { ProductEdits } from '../../domain/entities/product.entity';
import { ProductType, ControlledSchedule, RxClassification, StorageRequirement } from '../../domain/enums';
import { CatalogErrors } from '../../domain/errors';
import { productClassificationChangedEvent, productUpdatedEvent } from '../../domain/events';
import {
  CATEGORY_REPOSITORY,
  ICategoryRepository,
} from '../../domain/repositories/category.repository';
import {
  MANUFACTURER_REPOSITORY,
  IManufacturerRepository,
} from '../../domain/repositories/manufacturer.repository';
import { PRODUCT_REPOSITORY, IProductRepository } from '../../domain/repositories/product.repository';
import { UNIT_OF_WORK, IUnitOfWork } from '../ports/unit-of-work.port';
import { ProductDetailView, toProductDetailView } from '../queries/product-view';
import { runWithDedupRetry } from '../support/dedup-conflict';

export interface UpdateProductInput {
  actorUserId: string;
  productId: string;
  genericName?: string;
  brandName?: string;
  manufacturerId?: string | null;
  dosageForm?: string;
  strengthValue?: number;
  strengthUnit?: string;
  packSize?: string;
  atcCode?: string;
  rxClassification?: string | null;
  controlledSchedule?: string;
  storageRequirement?: string;
  nameAm?: string;
  nameEn?: string;
  descriptionAm?: string;
  descriptionEn?: string;
  warnings?: string;
  price?: number | null;
  categoryIds?: string[];
}

const DEDUP_KEY_FIELDS: (keyof UpdateProductInput)[] = [
  'genericName',
  'strengthValue',
  'strengthUnit',
  'dosageForm',
  'manufacturerId',
];

/**
 * `PATCH /admin/catalog/products/:id` (module-03 §8.2). `type` is never accepted (DTO omits it,
 * `forbidNonWhitelisted` rejects any attempt). Re-runs `ClassificationPolicy` if
 * `rxClassification`/`controlledSchedule` changes; re-runs the dedup check if any dedup-key
 * field changes.
 */
@Injectable()
export class UpdateProductCommand {
  constructor(
    @Inject(PRODUCT_REPOSITORY) private readonly products: IProductRepository,
    @Inject(CATEGORY_REPOSITORY) private readonly categories: ICategoryRepository,
    @Inject(MANUFACTURER_REPOSITORY) private readonly manufacturers: IManufacturerRepository,
    @Inject(UNIT_OF_WORK) private readonly uow: IUnitOfWork,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  async execute(input: UpdateProductInput): Promise<ProductDetailView> {
    const hasAnyField =
      Object.keys(input).filter((k) => k !== 'actorUserId' && k !== 'productId').length > 0;
    if (!hasAnyField) {
      throw CatalogErrors.validation('At least one field is required.');
    }

    const dedupKeyTouched = DEDUP_KEY_FIELDS.some((f) => input[f] !== undefined);

    // ADR-010: the update, category re-assignment, audit entry and outbox event(s) all commit
    // atomically in this one transaction. The medicine dedup pre-check (when a dedup-key field
    // changed) races concurrent edits the same way `CreateProductCommand` does; retried via the
    // same partial unique index / Serializable-conflict path (§11 edge case 5).
    const product = await runWithDedupRetry(this.uow, async (tx) => {
      const found = await this.products.findById(input.productId, tx);
      if (!found || found.deletedAt) {
        throw CatalogErrors.notFound();
      }

      if (input.manufacturerId) {
        const manufacturer = await this.manufacturers.findById(input.manufacturerId, tx);
        if (!manufacturer) {
          throw CatalogErrors.manufacturerNotFound();
        }
      }
      if (input.categoryIds && input.categoryIds.length > 0) {
        const foundCategories = await this.categories.findManyByIds(input.categoryIds);
        if (foundCategories.length !== new Set(input.categoryIds).size) {
          throw CatalogErrors.categoryNotFound();
        }
      }

      const before = found.classificationSnapshot();

      const edits: ProductEdits = {
        genericName: input.genericName,
        brandName: input.brandName,
        manufacturerId: input.manufacturerId,
        dosageForm: input.dosageForm,
        strengthValue: input.strengthValue,
        strengthUnit: input.strengthUnit,
        packSize: input.packSize,
        atcCode: input.atcCode,
        rxClassification: input.rxClassification as RxClassification | null | undefined,
        controlledSchedule: input.controlledSchedule as ControlledSchedule | undefined,
        storageRequirement: input.storageRequirement as StorageRequirement | undefined,
        nameAm: input.nameAm,
        nameEn: input.nameEn,
        descriptionAm: input.descriptionAm,
        descriptionEn: input.descriptionEn,
        warnings: input.warnings,
        price: input.price,
      };

      const changedFields = found.applyEdits(edits);
      const props = found.toProps();

      if (dedupKeyTouched && props.type === ProductType.MEDICINE) {
        const candidateId = await this.products.findDuplicateCandidate(
          {
            genericName: (props.genericName ?? '').trim().toLowerCase(),
            strengthValue: props.strengthValue,
            strengthUnit: props.strengthUnit,
            dosageForm: props.dosageForm,
            manufacturerId: props.manufacturerId as string,
          },
          found.id,
          tx,
        );
        if (candidateId) {
          throw CatalogErrors.duplicateProduct(candidateId);
        }
      }

      await this.products.save(found, tx);
      if (input.categoryIds !== undefined) {
        await this.products.setCategories(found.id, input.categoryIds, tx);
        if (!changedFields.includes('categoryIds')) {
          changedFields.push('categoryIds');
        }
      }

      await this.audit.record(
        {
          actorUserId: input.actorUserId,
          action: 'PRODUCT_UPDATED',
          resourceType: 'Product',
          resourceId: found.id,
          context: { fields: changedFields },
        },
        tx,
      );

      const after = found.classificationSnapshot();
      const classificationChanged =
        before.rxClassification !== after.rxClassification ||
        before.controlledSchedule !== after.controlledSchedule;

      await this.outbox.write(
        productUpdatedEvent({ productId: found.id, fields: changedFields }),
        tx as never,
      );
      if (classificationChanged) {
        await this.outbox.write(
          productClassificationChangedEvent({ productId: found.id, from: before, to: after }),
          tx as never,
        );
      }

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
