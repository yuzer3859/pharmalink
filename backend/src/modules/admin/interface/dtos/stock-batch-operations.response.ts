import {
  StockBatchOperationsDetail,
  StockBatchOperationsPage,
  StockBatchOperationsView,
} from '../../../pharmacy-inventory/application/ports/inbound/stock-batch-operations-read.port';

/**
 * One batch — ids, its own current on-hand `quantity`, `expiryDate` and `isExpired` at the response's
 * `generatedAt`, `receivedAt`, `createdAt`. No batch number, supplier, cost or reservation.
 */
export interface StockBatchOperationsResponse {
  batchId: string;
  listingId: string;
  pharmacyId: string;
  branchId: string;
  catalogProductId: string;
  quantity: number;
  expiryDate: string;
  isExpired: boolean;
  receivedAt: string | null;
  createdAt: string;
}

export interface StockBatchOperationsListResponse {
  generatedAt: string;
  items: StockBatchOperationsResponse[];
  total: number;
  page: number;
  size: number;
}

export interface StockBatchOperationsDetailResponse extends StockBatchOperationsResponse {
  generatedAt: string;
}

// Explicit allow-lists, never spreads of port objects.
export function toStockBatchOperationsResponse(b: StockBatchOperationsView): StockBatchOperationsResponse {
  return {
    batchId: b.batchId,
    listingId: b.listingId,
    pharmacyId: b.pharmacyId,
    branchId: b.branchId,
    catalogProductId: b.catalogProductId,
    quantity: b.quantity,
    expiryDate: b.expiryDate.toISOString(),
    isExpired: b.isExpired,
    receivedAt: b.receivedAt ? b.receivedAt.toISOString() : null,
    createdAt: b.createdAt.toISOString(),
  };
}

export function toStockBatchOperationsListResponse(p: StockBatchOperationsPage): StockBatchOperationsListResponse {
  return { generatedAt: p.generatedAt.toISOString(), items: p.items.map(toStockBatchOperationsResponse), total: p.total, page: p.page, size: p.size };
}

export function toStockBatchOperationsDetailResponse(d: StockBatchOperationsDetail): StockBatchOperationsDetailResponse {
  return { ...toStockBatchOperationsResponse(d.batch), generatedAt: d.generatedAt.toISOString() };
}
