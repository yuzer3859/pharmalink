import { authService, type SessionRequest } from './auth.service';

/**
 * Work 112: the pharmacy portal's inventory on the real API (module-04 §9.3, Work 111's read).
 * Every route is scoped to the signed-in user's pharmacy and needs `inventory:manage:org`, except
 * the branch list (`pharmacy:manage:org`) and the public catalogue search.
 * Money is integer santim on the wire; the form takes birr.
 */

export interface InventoryBatch {
  id: string;
  listingId: string;
  batchNumber: string;
  quantity: number;
  expiryDate: string;
  supplier: string | null;
  receivedAt: string | null;
  createdAt: string;
}

export interface InventoryListing {
  id: string;
  pharmacyId: string;
  branchId: string;
  catalogProductId: string;
  productName: string | null;
  price: number;
  currency: string;
  onHand: number;
  reserved: number;
  sellable: number;
  isEnabled: boolean;
  storageRequirement: string;
  createdAt: string;
  updatedAt: string;
}

export interface InventoryListingDetail extends InventoryListing {
  batches: InventoryBatch[];
}

export interface ListingPage {
  items: InventoryListing[];
  total: number;
  page: number;
  size: number;
}

export interface StockMovement {
  id: string;
  batchId: string | null;
  type: string;
  quantityDelta: number;
  reason: string | null;
  refType: string | null;
  createdAt: string;
}

export interface Branch {
  id: string;
  name: string;
}

export interface CatalogHit {
  id: string;
  nameEn?: string | null;
  genericName?: string | null;
  brandName?: string | null;
  rxClassification?: string | null;
  status?: string;
}

export interface NewListing {
  catalogProductId: string;
  branchId: string;
  /** Birr, as typed. */
  priceBirr: number;
  batchNumber: string;
  initialQuantity: number;
  /** `YYYY-MM-DD`. */
  expiryDate: string;
  supplier?: string;
}

export interface NewBatch {
  batchNumber: string;
  quantity: number;
  expiryDate: string;
  supplier?: string;
}

/** Below this many sellable units a listing reads as low stock. */
export const LOW_STOCK_AT = 10;

export type StockLevel = 'out_of_stock' | 'low_stock' | 'in_stock' | 'disabled';

export function stockLevel(listing: Pick<InventoryListing, 'sellable' | 'isEnabled'>): StockLevel {
  if (!listing.isEnabled) return 'disabled';
  if (listing.sellable <= 0) return 'out_of_stock';
  if (listing.sellable < LOW_STOCK_AT) return 'low_stock';
  return 'in_stock';
}

/** Birr to integer santim; `null` when it is not a positive amount. */
export function toSantim(birr: number): number | null {
  if (!Number.isFinite(birr) || birr <= 0) return null;
  return Math.round(birr * 100);
}

export const productLabel = (hit: CatalogHit) => hit.nameEn || hit.genericName || hit.brandName || 'Unnamed product';

const isDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value));
const isFuture = (value: string) => Date.parse(`${value}T23:59:59Z`) > Date.now();

/** The server's batch rules: number 1-60 characters, a whole quantity of at least 1, a date. */
export function batchProblem(batch: NewBatch): string | null {
  const number = batch.batchNumber.trim();
  if (number.length < 1 || number.length > 60) return 'Batch number: 1 to 60 characters.';
  if (!Number.isInteger(batch.quantity) || batch.quantity < 1) return 'Quantity: a whole number of at least 1.';
  if (!isDate(batch.expiryDate)) return 'Expiry: a date.';
  if (!isFuture(batch.expiryDate)) return 'This batch has already expired.';
  return null;
}

export function newListingProblem(listing: NewListing): string | null {
  if (!listing.catalogProductId) return 'Choose a product.';
  if (!listing.branchId) return 'Choose a branch.';
  if (toSantim(listing.priceBirr) === null) return 'Price: an amount above 0.';
  return batchProblem({ batchNumber: listing.batchNumber, quantity: listing.initialQuantity, expiryDate: listing.expiryDate, supplier: listing.supplier });
}

/** The server's adjustment rules: a non-zero whole change, and a reason of 3 to 300 characters. */
export function adjustmentProblem(quantityDelta: number, reason: string, batchQuantity: number): string | null {
  if (!Number.isInteger(quantityDelta) || quantityDelta === 0) return 'Change: a whole number other than 0 (negative to remove).';
  if (batchQuantity + quantityDelta < 0) return `This batch has only ${batchQuantity}.`;
  const length = reason.trim().length;
  if (length < 3 || length > 300) return 'Reason: 3 to 300 characters.';
  return null;
}

export function listingQuery(filters: { branchId?: string; page?: number; size?: number }): string {
  const params = new URLSearchParams();
  if (filters.branchId) params.set('branchId', filters.branchId);
  if (filters.page) params.set('page', String(filters.page));
  if (filters.size) params.set('size', String(Math.min(filters.size, 50)));
  const query = params.toString();
  return query ? `?${query}` : '';
}

export function createPharmacyInventoryService(request: SessionRequest) {
  const listing = (id: string, rest = '') => `/inventory/listings/${encodeURIComponent(id)}${rest}`;
  return {
    list(filters: { branchId?: string; page?: number; size?: number } = {}): Promise<ListingPage> {
      return request<ListingPage>(`/inventory/listings${listingQuery(filters)}`, { method: 'GET' });
    },
    get(id: string): Promise<InventoryListingDetail> {
      return request<InventoryListingDetail>(listing(id), { method: 'GET' });
    },
    movements(id: string, page = 1, size = 20): Promise<{ items: StockMovement[]; total: number }> {
      return request(listing(id, `/movements?page=${page}&size=${Math.min(size, 50)}`), { method: 'GET' });
    },
    create(input: NewListing): Promise<{ listingId: string }> {
      return request(`/inventory/listings`, {
        method: 'POST',
        body: {
          catalogProductId: input.catalogProductId,
          branchId: input.branchId,
          price: toSantim(input.priceBirr),
          batchNumber: input.batchNumber.trim(),
          initialQuantity: input.initialQuantity,
          expiryDate: new Date(`${input.expiryDate}T00:00:00Z`).toISOString(),
          ...(input.supplier?.trim() ? { supplier: input.supplier.trim() } : {}),
        },
      });
    },
    update(id: string, patch: { priceBirr?: number; isEnabled?: boolean }): Promise<unknown> {
      const body: Record<string, unknown> = {};
      if (patch.priceBirr !== undefined) body.price = toSantim(patch.priceBirr);
      if (patch.isEnabled !== undefined) body.isEnabled = patch.isEnabled;
      return request(listing(id), { method: 'PATCH', body });
    },
    remove(id: string): Promise<unknown> {
      return request(listing(id), { method: 'DELETE' });
    },
    receive(id: string, batch: NewBatch): Promise<unknown> {
      return request(listing(id, '/batches'), {
        method: 'POST',
        body: {
          batchNumber: batch.batchNumber.trim(),
          quantity: batch.quantity,
          expiryDate: new Date(`${batch.expiryDate}T00:00:00Z`).toISOString(),
          ...(batch.supplier?.trim() ? { supplier: batch.supplier.trim() } : {}),
        },
      });
    },
    adjust(batchId: string, quantityDelta: number, reason: string): Promise<unknown> {
      return request(`/inventory/batches/${encodeURIComponent(batchId)}`, { method: 'PATCH', body: { quantityDelta, reason: reason.trim() } });
    },
    branches(): Promise<Branch[]> {
      return request<Branch[]>(`/pharmacy/branches`, { method: 'GET' });
    },
    searchProducts(q: string): Promise<{ items: CatalogHit[] }> {
      return request(`/catalog/products?q=${encodeURIComponent(q.trim())}&size=10`, { method: 'GET' });
    },
  };
}

export const pharmacyInventoryService = createPharmacyInventoryService(authService.request);
