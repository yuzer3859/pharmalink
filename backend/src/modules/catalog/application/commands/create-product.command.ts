import { randomUUID } from 'crypto';
import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../../../shared/audit/audit.service';
import { OutboxService } from '../../../../shared/outbox/outbox.service';
import { Product, NewProductProps } from '../../domain/entities/product.entity';
import { CatalogErrors } from '../../domain/errors';
import { ControlledSchedule, ProductType, RxClassification, StorageRequirement } from '../../domain/enums';
import { productCreatedEvent } from '../../domain/events';
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

export interface CreateProductInput {
  actorUserId: string;
  type: string;
  genericName?: string;
  brandName?: string;
  manufacturerId?: string;
  dosageForm?: string;
  strengthValue?: number;
  strengthUnit?: string;
  packSize?: string;
  atcCode?: string;
  rxClassification?: string;
  controlledSchedule?: string;
  storageRequirement?: string;
  nameAm?: string;
  nameEn?: string;
  descriptionAm?: string;
  descriptionEn?: string;
  warnings?: string;
  price?: number;
  categoryIds?: string[];
}

/**
 * `POST /admin/catalog/products` (module-03 §8.2). Order of checks: DTO validation (upstream)
 * -> manufacturer/category existence -> domain invariants (display name, classification,
 * manufacturer requirement) -> medicine dedup check -> persist -> audit -> outbox.
 */
@Injectable()
export class CreateProductCommand {
  constructor(
    @Inject(PRODUCT_REPOSITORY) private readonly products: IProductRepository,
    @Inject(CATEGORY_REPOSITORY) private readonly categories: ICategoryRepository,
    @Inject(MANUFACTURER_REPOSITORY) private readonly manufacturers: IManufacturerRepository,
    @Inject(UNIT_OF_WORK) private readonly uow: IUnitOfWork,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  async execute(input: CreateProductInput): Promise<ProductDetailView> {
    const type = input.type as ProductType;
    const categoryIds = input.categoryIds ?? [];

    // ADR-010: the insert, category assignment, audit entry and outbox event all commit
    // atomically in this one transaction — a failure anywhere in the closure rolls back all of
    // them, never leaving an orphan product row, audit entry, or missed event. The medicine
    // dedup pre-check races concurrent creates of the same medicine; the partial unique index
    // (§6.2) — and, since the whole transaction runs at Serializable isolation to keep the audit
    // hash chain fork-safe, a write-conflict from a concurrent audit append — rejects a losing
    // commit, which we retry against re-read state instead of 500ing (§11 edge case 5).
    const product = await runWithDedupRetry(this.uow, async (tx) => {
      if (input.manufacturerId) {
        const manufacturer = await this.manufacturers.findById(input.manufacturerId, tx);
        if (!manufacturer) {
          throw CatalogErrors.manufacturerNotFound();
        }
      }
      if (categoryIds.length > 0) {
        const found = await this.categories.findManyByIds(categoryIds);
        if (found.length !== new Set(categoryIds).size) {
          throw CatalogErrors.categoryNotFound();
        }
      }

      const newProps: NewProductProps = {
        type,
        genericName: input.genericName,
        brandName: input.brandName,
        manufacturerId: input.manufacturerId,
        dosageForm: input.dosageForm,
        strengthValue: input.strengthValue,
        strengthUnit: input.strengthUnit,
        packSize: input.packSize,
        atcCode: input.atcCode,
        rxClassification: input.rxClassification as RxClassification | undefined,
        controlledSchedule: input.controlledSchedule as ControlledSchedule | undefined,
        storageRequirement: input.storageRequirement as StorageRequirement | undefined,
        nameAm: input.nameAm,
        nameEn: input.nameEn,
        descriptionAm: input.descriptionAm,
        descriptionEn: input.descriptionEn,
        warnings: input.warnings,
        price: input.price,
        createdBy: input.actorUserId,
      };

      const created = Product.create(randomUUID(), newProps);

      if (type === ProductType.MEDICINE) {
        const candidateId = await this.products.findDuplicateCandidate(
          {
            genericName: (input.genericName ?? '').trim().toLowerCase(),
            strengthValue: input.strengthValue ?? null,
            strengthUnit: input.strengthUnit ?? null,
            dosageForm: input.dosageForm ?? null,
            manufacturerId: input.manufacturerId as string,
          },
          undefined,
          tx,
        );
        if (candidateId) {
          throw CatalogErrors.duplicateProduct(candidateId);
        }
      }

      await this.products.create(created, tx);
      if (categoryIds.length > 0) {
        await this.products.setCategories(created.id, categoryIds, tx);
      }

      const props = created.toProps();
      await this.audit.record(
        {
          actorUserId: input.actorUserId,
          action: 'PRODUCT_CREATED',
          resourceType: 'Product',
          resourceId: created.id,
          context: {
            type: props.type,
            rxClassification: props.rxClassification,
            controlledSchedule: props.controlledSchedule,
          },
        },
        tx,
      );

      await this.outbox.write(
        productCreatedEvent({
          productId: created.id,
          type: props.type,
          rxClassification: props.rxClassification,
          controlledSchedule: props.controlledSchedule,
        }),
        tx as never,
      );

      return created;
    });

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
