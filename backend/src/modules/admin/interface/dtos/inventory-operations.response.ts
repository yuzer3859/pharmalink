import { InventoryOperationsOverview } from '../../application/queries/get-inventory-operations-overview.query';
import { StatusCountResponse } from './analytics.response';

/** The inventory operations snapshot — aggregate counts only; no pharmacy, listing or product. */
export interface InventoryOperationsOverviewResponse {
  generatedAt: string;
  pharmacies: {
    total: number;
    byTransactingStatus: StatusCountResponse[];
    eligible: number;
    eligibleWithAvailableStock: number;
    eligibleWithoutAvailableStock: number;
  };
  inventory: {
    totalTrackedItems: number;
    enabledItems: number;
    disabledItems: number;
    inStockItems: number;
    outOfStockItems: number;
  };
  products: { total: number; byStatus: StatusCountResponse[] };
}

const buckets = (rows: { status: string; count: number }[]): StatusCountResponse[] => rows.map((r) => ({ status: r.status, count: r.count }));

// Explicit allow-list, never a spread.
export function toInventoryOperationsOverviewResponse(v: InventoryOperationsOverview): InventoryOperationsOverviewResponse {
  return {
    generatedAt: v.generatedAt.toISOString(),
    pharmacies: {
      total: v.pharmacies.total,
      byTransactingStatus: buckets(v.pharmacies.byTransactingStatus),
      eligible: v.pharmacies.eligible,
      eligibleWithAvailableStock: v.pharmacies.eligibleWithAvailableStock,
      eligibleWithoutAvailableStock: v.pharmacies.eligibleWithoutAvailableStock,
    },
    inventory: {
      totalTrackedItems: v.inventory.totalTrackedItems,
      enabledItems: v.inventory.enabledItems,
      disabledItems: v.inventory.disabledItems,
      inStockItems: v.inventory.inStockItems,
      outOfStockItems: v.inventory.outOfStockItems,
    },
    products: { total: v.products.total, byStatus: buckets(v.products.byStatus) },
  };
}
