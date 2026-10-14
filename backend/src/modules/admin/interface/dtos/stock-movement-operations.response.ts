import {
  StockMovementOperationsPage,
  StockMovementOperationsView,
} from '../../../pharmacy-inventory/application/ports/inbound/stock-movement-operations-read.port';

/**
 * One recorded movement — ids, its type, the signed `quantityDelta` as written, the kind of source,
 * and when. What the delta moved depends on `type`; no balance is given. No reason text, order/import
 * id, reservation or actor.
 */
export interface StockMovementOperationsResponse {
  movementId: string;
  listingId: string;
  pharmacyId: string;
  branchId: string;
  catalogProductId: string;
  batchId: string | null;
  type: string;
  quantityDelta: number;
  refType: string | null;
  createdAt: string;
}

export interface StockMovementOperationsListResponse {
  items: StockMovementOperationsResponse[];
  total: number;
  page: number;
  size: number;
}

// Explicit allow-list, never a spread of the port object.
export function toStockMovementOperationsResponse(m: StockMovementOperationsView): StockMovementOperationsResponse {
  return {
    movementId: m.movementId,
    listingId: m.listingId,
    pharmacyId: m.pharmacyId,
    branchId: m.branchId,
    catalogProductId: m.catalogProductId,
    batchId: m.batchId,
    type: m.type,
    quantityDelta: m.quantityDelta,
    refType: m.refType,
    createdAt: m.createdAt.toISOString(),
  };
}

export function toStockMovementOperationsListResponse(p: StockMovementOperationsPage): StockMovementOperationsListResponse {
  return { items: p.items.map(toStockMovementOperationsResponse), total: p.total, page: p.page, size: p.size };
}
