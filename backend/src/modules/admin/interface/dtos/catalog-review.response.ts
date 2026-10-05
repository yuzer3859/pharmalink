import {
  CatalogAdminProductPage,
  CatalogAdminProductRow,
} from '../../../catalog/application/ports/inbound/catalog-admin-read.port';

/** One row of `GET /admin/catalog/review`. See `CatalogAdminProductRow` for what is withheld. */
export interface CatalogReviewItemResponse {
  id: string;
  type: string;
  genericName: string | null;
  brandName: string | null;
  nameAm: string | null;
  nameEn: string | null;
  dosageForm: string | null;
  strengthValue: number | null;
  strengthUnit: string | null;
  rxClassification: string | null;
  controlledSchedule: string;
  onlineSaleProhibited: boolean;
  manufacturerName: string | null;
  /** ETB minor units; `null` = unpriced, therefore not purchasable. */
  price: number | null;
  status: string;
  /** What `POST /admin/catalog/products/:id/status` accepts from `status`, as Module 03 decides it. */
  allowedTransitions: string[];
  createdAt: string;
  updatedAt: string;
}

export interface CatalogReviewListResponse {
  items: CatalogReviewItemResponse[];
  total: number;
  page: number;
  size: number;
}

// Explicit allow-list, never a spread of the port's row.
function toItem(row: CatalogAdminProductRow): CatalogReviewItemResponse {
  return {
    id: row.id,
    type: row.type,
    genericName: row.genericName,
    brandName: row.brandName,
    nameAm: row.nameAm,
    nameEn: row.nameEn,
    dosageForm: row.dosageForm,
    strengthValue: row.strengthValue,
    strengthUnit: row.strengthUnit,
    rxClassification: row.rxClassification,
    controlledSchedule: row.controlledSchedule,
    onlineSaleProhibited: row.onlineSaleProhibited,
    manufacturerName: row.manufacturerName,
    price: row.price,
    status: row.status,
    allowedTransitions: [...row.allowedTransitions],
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toCatalogReviewListResponse(result: CatalogAdminProductPage): CatalogReviewListResponse {
  return {
    items: result.items.map(toItem),
    total: result.total,
    page: result.page,
    size: result.size,
  };
}
