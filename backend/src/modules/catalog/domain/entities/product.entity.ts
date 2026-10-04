import { CatalogErrors } from '../errors';
import {
  ControlledSchedule,
  ProductStatus,
  ProductType,
  RxClassification,
  StorageRequirement,
} from '../enums';
import { ClassificationPolicy } from '../services/classification-policy';
import { ProductStatusPolicy } from '../services/product-status-policy';

export interface ProductProps {
  id: string;
  type: ProductType;
  genericName: string | null;
  brandName: string | null;
  manufacturerId: string | null;
  dosageForm: string | null;
  strengthValue: number | null;
  strengthUnit: string | null;
  packSize: string | null;
  atcCode: string | null;
  rxClassification: RxClassification | null;
  controlledSchedule: ControlledSchedule;
  onlineSaleProhibited: boolean;
  storageRequirement: StorageRequirement;
  equivalenceGroupId: string | null;
  nameAm: string | null;
  nameEn: string | null;
  descriptionAm: string | null;
  descriptionEn: string | null;
  warnings: string | null;
  /** Platform reference price, ETB integer minor units (`00-shared-conventions.md` §11 — money
   * is never a float). `null` means "not priced, therefore not purchasable": Module 06's
   * `ICatalogPort` adapter reports such a product as not found rather than pricing an order line
   * at zero. Distinct from `InventoryListing.price` (Module 04), the per-pharmacy selling
   * price — Catalog owns the reference price, Inventory owns what a given pharmacy charges. */
  price: number | null;
  status: ProductStatus;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

/** Fields required to create a brand-new product (module-03 §4.1). `type` is fixed for the
 * product's lifetime — never present in `ProductEdits`. */
export interface NewProductProps {
  type: ProductType;
  genericName?: string | null;
  brandName?: string | null;
  manufacturerId?: string | null;
  dosageForm?: string | null;
  strengthValue?: number | null;
  strengthUnit?: string | null;
  packSize?: string | null;
  atcCode?: string | null;
  rxClassification?: RxClassification | null;
  controlledSchedule?: ControlledSchedule;
  storageRequirement?: StorageRequirement;
  nameAm?: string | null;
  nameEn?: string | null;
  descriptionAm?: string | null;
  descriptionEn?: string | null;
  warnings?: string | null;
  price?: number | null;
  createdBy?: string | null;
}

/** Fields `UpdateProductCommand` may change (module-03 §4.1, PATCH semantics, `type` omitted). */
export interface ProductEdits {
  genericName?: string | null;
  brandName?: string | null;
  manufacturerId?: string | null;
  dosageForm?: string | null;
  strengthValue?: number | null;
  strengthUnit?: string | null;
  packSize?: string | null;
  atcCode?: string | null;
  rxClassification?: RxClassification | null;
  controlledSchedule?: ControlledSchedule;
  storageRequirement?: StorageRequirement;
  nameAm?: string | null;
  nameEn?: string | null;
  descriptionAm?: string | null;
  descriptionEn?: string | null;
  warnings?: string | null;
  price?: number | null;
}

export interface ClassificationSnapshot {
  rxClassification: RxClassification | null;
  controlledSchedule: ControlledSchedule;
}

/**
 * Product aggregate root (module-03 §3.1). Framework-free. Encodes the compliance-critical
 * invariants (§3.6) so the application layer never has to re-derive them.
 */
export class Product {
  private constructor(private props: ProductProps) {}

  static rehydrate(props: ProductProps): Product {
    return new Product(props);
  }

  static create(id: string, input: NewProductProps, now: Date = new Date()): Product {
    const rxClassification = input.rxClassification ?? null;
    const manufacturerId = input.manufacturerId ?? null;
    const controlledSchedule = input.controlledSchedule ?? ControlledSchedule.NONE;

    Product.assertHasDisplayName(input.nameEn ?? null, input.brandName ?? null);
    Product.assertValidPrice(input.price ?? null);
    ClassificationPolicy.assertValidClassification(input.type, rxClassification);
    ClassificationPolicy.assertManufacturerRequirement(input.type, manufacturerId);

    return new Product({
      id,
      type: input.type,
      genericName: input.genericName ?? null,
      brandName: input.brandName ?? null,
      manufacturerId,
      dosageForm: input.dosageForm ?? null,
      strengthValue: input.strengthValue ?? null,
      strengthUnit: input.strengthUnit ?? null,
      packSize: input.packSize ?? null,
      atcCode: input.atcCode ?? null,
      rxClassification,
      controlledSchedule,
      onlineSaleProhibited: ClassificationPolicy.deriveOnlineSaleProhibited(controlledSchedule),
      storageRequirement: input.storageRequirement ?? StorageRequirement.AMBIENT,
      equivalenceGroupId: null,
      nameAm: input.nameAm ?? null,
      nameEn: input.nameEn ?? null,
      descriptionAm: input.descriptionAm ?? null,
      descriptionEn: input.descriptionEn ?? null,
      warnings: input.warnings ?? null,
      price: input.price ?? null,
      status: ProductStatus.DRAFT,
      createdBy: input.createdBy ?? null,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    });
  }

  get id(): string {
    return this.props.id;
  }
  get type(): ProductType {
    return this.props.type;
  }
  get status(): ProductStatus {
    return this.props.status;
  }
  get manufacturerId(): string | null {
    return this.props.manufacturerId;
  }
  get deletedAt(): Date | null {
    return this.props.deletedAt;
  }

  classificationSnapshot(): ClassificationSnapshot {
    return {
      rxClassification: this.props.rxClassification,
      controlledSchedule: this.props.controlledSchedule,
    };
  }

  /**
   * Applies a PATCH edit set. Re-runs the classification/manufacturer invariants whenever a
   * relevant field changes (module-03 §3.6 invariants 1/8) and the display-name rule whenever
   * `nameEn`/`brandName` are touched. Returns the list of changed field names (audit-safe: names
   * only, never values, §12).
   */
  applyEdits(edits: ProductEdits, now: Date = new Date()): string[] {
    const changed: string[] = [];
    const next = { ...this.props };

    const setIfDefined = <K extends keyof ProductEdits>(key: K): void => {
      if (edits[key] !== undefined) {
        (next as Record<string, unknown>)[key] = edits[key];
        changed.push(key as string);
      }
    };

    setIfDefined('genericName');
    setIfDefined('brandName');
    setIfDefined('manufacturerId');
    setIfDefined('dosageForm');
    setIfDefined('strengthValue');
    setIfDefined('strengthUnit');
    setIfDefined('packSize');
    setIfDefined('atcCode');
    setIfDefined('rxClassification');
    setIfDefined('controlledSchedule');
    setIfDefined('storageRequirement');
    setIfDefined('nameAm');
    setIfDefined('nameEn');
    setIfDefined('descriptionAm');
    setIfDefined('descriptionEn');
    setIfDefined('warnings');
    setIfDefined('price');

    if (changed.length === 0) {
      return changed;
    }

    if (changed.includes('nameEn') || changed.includes('brandName')) {
      Product.assertHasDisplayName(next.nameEn, next.brandName);
    }
    if (changed.includes('price')) {
      Product.assertValidPrice(next.price);
    }
    if (changed.includes('rxClassification') || changed.includes('controlledSchedule')) {
      ClassificationPolicy.assertValidClassification(next.type, next.rxClassification);
    }
    if (changed.includes('manufacturerId')) {
      ClassificationPolicy.assertManufacturerRequirement(next.type, next.manufacturerId);
    }

    next.onlineSaleProhibited = ClassificationPolicy.deriveOnlineSaleProhibited(
      next.controlledSchedule,
    );
    next.updatedAt = now;
    this.props = next;
    return changed;
  }

  /** §4.1: at least one of `nameEn` or `brandName` must be present (display-name rule). */
  private static assertHasDisplayName(nameEn: string | null, brandName: string | null): void {
    if (!nameEn && !brandName) {
      throw CatalogErrors.validation('Provide nameEn or brandName so the product is displayable.', {
        field: 'nameEn',
      });
    }
  }

  /**
   * Money is integer minor units, never a float (`00-shared-conventions.md` §11), and a negative
   * reference price is never a valid catalog state. Enforced in the domain rather than only in
   * the DTO so the rule holds for every writer of this aggregate, not just the HTTP surface.
   * `null` is explicitly allowed — it is the "not priced yet" state, not a missing value to
   * default to zero.
   */
  private static assertValidPrice(price: number | null): void {
    if (price === null || price === undefined) {
      return;
    }
    if (!Number.isInteger(price) || price < 0) {
      throw CatalogErrors.validation(
        'price must be a non-negative integer in ETB minor units.',
        { field: 'price' },
      );
    }
  }

  /** §3.6 invariant 6: state-machine-checked status transition. */
  transitionStatus(to: ProductStatus, now: Date = new Date()): void {
    ProductStatusPolicy.assertValidTransition(this.props.status, to);
    this.props.status = to;
    this.props.updatedAt = now;
  }

  toProps(): Readonly<ProductProps> {
    return { ...this.props };
  }
}
