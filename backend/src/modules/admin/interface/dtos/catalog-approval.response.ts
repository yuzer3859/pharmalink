import { ApprovedProductView } from '../../../catalog/application/ports/inbound/catalog-review-approval.port';

/**
 * The approved product — exactly the fields Module 03's own status route returns
 * (`ProductDetailView`: the catalogue record, never `createdBy`). No inventory, listing, pharmacy
 * or supplier data exists on a catalogue product to leak.
 */
export interface ApprovedProductResponse {
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
  price: number | null;
  status: string;
  createdAt: string;
  updatedAt: string;
  categories: Array<{ id: string; slug: string; nameAm: string | null; nameEn: string | null }>;
}

// Explicit allow-list, never a spread.
export function toApprovedProductResponse(p: ApprovedProductView): ApprovedProductResponse {
  return {
    id: p.id,
    type: p.type,
    genericName: p.genericName,
    brandName: p.brandName,
    manufacturerId: p.manufacturerId,
    dosageForm: p.dosageForm,
    strengthValue: p.strengthValue,
    strengthUnit: p.strengthUnit,
    packSize: p.packSize,
    atcCode: p.atcCode,
    rxClassification: p.rxClassification,
    controlledSchedule: p.controlledSchedule,
    onlineSaleProhibited: p.onlineSaleProhibited,
    storageRequirement: p.storageRequirement,
    equivalenceGroupId: p.equivalenceGroupId,
    nameAm: p.nameAm,
    nameEn: p.nameEn,
    descriptionAm: p.descriptionAm,
    descriptionEn: p.descriptionEn,
    warnings: p.warnings,
    price: p.price,
    status: p.status,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
    categories: p.categories.map((c) => ({ id: c.id, slug: c.slug, nameAm: c.nameAm, nameEn: c.nameEn })),
  };
}
