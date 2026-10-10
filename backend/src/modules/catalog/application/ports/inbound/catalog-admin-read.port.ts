import { ProductStatus, ProductType } from '../../../domain/enums';

export const CATALOG_ADMIN_READ_PORT = Symbol('CATALOG_ADMIN_READ_PORT');

/** Re-exported so a consumer depends on this one file and not on Module 03's domain layer. */
export { ProductStatus, ProductType } from '../../../domain/enums';

/**
 * The filters Module 03 can answer for an administrator. `status` is required: the list is
 * always "products in one lifecycle state", never a mixed bag. `type` and `q` carry the same
 * meaning as on the public search (`PrismaProductRepository.search`) — `q` is the same
 * case-insensitive substring match over the four product names.
 */
export interface CatalogAdminProductFilter {
  status: ProductStatus;
  type?: ProductType;
  q?: string;
}

/**
 * One product as an administrator sees it in a list. The public summary's fields plus what an
 * administrator needs to act: the lifecycle status, the regulatory flags that decide whether the
 * product may be sold online, the reference price (`null` = unpriced, not purchasable), and
 * timestamps. `createdBy` is withheld, as `ProductDetailView` withholds it (§8.1: internal-only);
 * descriptions and warnings are withheld as the public list withholds them — the full record is
 * `GET /admin/catalog/products/:id`.
 */
export interface CatalogAdminProductRow {
  id: string;
  type: ProductType;
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
  price: number | null;
  status: ProductStatus;
  /**
   * The statuses `ProductStatusPolicy` allows from this one, in `ProductStatus` declaration order.
   * `POST /admin/catalog/products/:id/status` accepts each of them except `PENDING_REVIEW`, which
   * is entered only through `POST /admin/catalog/review/:productId/submit` (module-16 Work 29) — so a
   * DRAFT, whose only allowed transition it is since Work 30, leaves only through review. Computed
   * by Module 03 so that no consumer keeps a copy of the state machine.
   */
  allowedTransitions: ProductStatus[];
  createdAt: Date;
  updatedAt: Date;
}

export interface CatalogAdminProductPage {
  items: CatalogAdminProductRow[];
  total: number;
  page: number;
  size: number;
}

/**
 * Module 03's exported contract for **read-only administrative catalogue listing**, consumed
 * in-process by Module 16 (module-16 Work 09). Soft-deleted products are excluded, as every
 * Module 03 read excludes them. It lists; it never changes a product — the only status writer
 * remains `ChangeProductStatusCommand` behind Module 03's own route.
 */
export interface ICatalogAdminReadPort {
  listProducts(filter: CatalogAdminProductFilter, page: number, size: number): Promise<CatalogAdminProductPage>;
}
