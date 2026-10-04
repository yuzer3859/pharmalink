import type { InventoryItem, StockStatus } from '@/types';
import { INVENTORY } from './mock/seed';
import { simulate, nextId } from './apiClient';
import type { DataScope } from './scope';

let store: InventoryItem[] = [...INVENTORY];

export interface InventoryFilters {
  search?: string;
  category?: string;
  status?: StockStatus | 'all';
}

const deriveStatus = (item: Pick<InventoryItem, 'quantity' | 'reorderLevel' | 'expiryDate'>): StockStatus => {
  if (new Date(item.expiryDate).getTime() < Date.now()) return 'expired';
  if (item.quantity === 0) return 'out_of_stock';
  if (item.quantity <= item.reorderLevel) return 'low_stock';
  return 'in_stock';
};

export const inventoryService = {
  list(scope: DataScope, filters: InventoryFilters = {}) {
    let rows = store;
    if (scope.portal === 'pharmacy' && scope.pharmacyId) {
      rows = rows.filter((r) => r.pharmacyId === scope.pharmacyId);
    }
    if (filters.category && filters.category !== 'all') {
      rows = rows.filter((r) => r.category === filters.category);
    }
    if (filters.status && filters.status !== 'all') {
      rows = rows.filter((r) => r.status === filters.status);
    }
    if (filters.search) {
      const q = filters.search.toLowerCase();
      rows = rows.filter(
        (r) =>
          r.name.toLowerCase().includes(q) ||
          r.genericName.toLowerCase().includes(q) ||
          r.sku.toLowerCase().includes(q),
      );
    }
    return simulate(rows);
  },

  categories() {
    return simulate(Array.from(new Set(store.map((r) => r.category))).sort());
  },

  create(input: Omit<InventoryItem, 'id' | 'status' | 'updatedAt'>) {
    const item: InventoryItem = {
      ...input,
      id: nextId('inv'),
      status: deriveStatus(input),
      updatedAt: new Date().toISOString(),
    };
    store = [item, ...store];
    return simulate(item);
  },

  update(id: string, patch: Partial<InventoryItem>) {
    store = store.map((r) => {
      if (r.id !== id) return r;
      const merged = { ...r, ...patch, updatedAt: new Date().toISOString() };
      merged.status = deriveStatus(merged);
      return merged;
    });
    return simulate(store.find((r) => r.id === id)!);
  },

  remove(id: string) {
    store = store.filter((r) => r.id !== id);
    return simulate({ id });
  },
};
