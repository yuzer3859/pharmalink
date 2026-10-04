import { Product } from '../../domain/entities/product.entity';
import { ProductSummaryRow } from '../../domain/repositories/product.repository';

/** §8.1: list view, kept light for list rendering — no `warnings`/`descriptions`. */
export type ProductSummaryView = ProductSummaryRow;

export interface CategorySummary {
  id: string;
  slug: string;
  nameAm: string | null;
  nameEn: string | null;
}

/** §8.1: full detail — every §3.1 field except the internal-only `createdBy`. */
export interface ProductDetailView {
  id: string;
  type: string;
  genericName: string | null;
  brandName: string | null;
  manufacturerId: string | null;
  dosageForm: string | null;
  strengthValue: number | null;
  strengthUnit: string | null;
  packSize: string | null;
  atcCode: string | null;
  rxClassification: string | null;
  controlledSchedule: string;
  onlineSaleProhibited: boolean;
  storageRequirement: string;
  equivalenceGroupId: string | null;
  nameAm: string | null;
  nameEn: string | null;
  descriptionAm: string | null;
  descriptionEn: string | null;
  warnings: string | null;
  /** Platform reference price in ETB integer minor units, or `null` when the product has not
   * been priced (`00-shared-conventions.md` §11). This is Catalog's own reference price, not a
   * per-pharmacy selling price — Module 04's `InventoryListing.price` remains that. */
  price: number | null;
  status: string;
  createdAt: Date;
  updatedAt: Date;
  categories: CategorySummary[];
}

export function toProductDetailView(product: Product, categories: CategorySummary[]): ProductDetailView {
  const props = product.toProps();
  return {
    id: props.id,
    type: props.type,
    genericName: props.genericName,
    brandName: props.brandName,
    manufacturerId: props.manufacturerId,
    dosageForm: props.dosageForm,
    strengthValue: props.strengthValue,
    strengthUnit: props.strengthUnit,
    packSize: props.packSize,
    atcCode: props.atcCode,
    rxClassification: props.rxClassification,
    controlledSchedule: props.controlledSchedule,
    onlineSaleProhibited: props.onlineSaleProhibited,
    storageRequirement: props.storageRequirement,
    equivalenceGroupId: props.equivalenceGroupId,
    nameAm: props.nameAm,
    nameEn: props.nameEn,
    descriptionAm: props.descriptionAm,
    descriptionEn: props.descriptionEn,
    warnings: props.warnings,
    price: props.price,
    status: props.status,
    createdAt: props.createdAt,
    updatedAt: props.updatedAt,
    categories,
  };
}
