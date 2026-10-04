import type { Order, OrderStatus } from '@/types';
import { ORDERS } from './mock/seed';
import { simulate } from './apiClient';
import type { DataScope } from './scope';

let store: Order[] = [...ORDERS];

export interface OrderFilters {
  search?: string;
  status?: OrderStatus | 'all';
}

export const ORDER_FLOW: OrderStatus[] = [
  'placed', 'verified', 'accepted', 'dispatched', 'delivered', 'completed',
];

export const ordersService = {
  list(scope: DataScope, filters: OrderFilters = {}) {
    let rows = store;
    if (scope.portal === 'pharmacy' && scope.pharmacyId) {
      rows = rows.filter((r) => r.pharmacyId === scope.pharmacyId);
    }
    if (filters.status && filters.status !== 'all') {
      rows = rows.filter((r) => r.status === filters.status);
    }
    if (filters.search) {
      const q = filters.search.toLowerCase();
      rows = rows.filter(
        (r) => r.reference.toLowerCase().includes(q) || r.customerName.toLowerCase().includes(q),
      );
    }
    return simulate([...rows].sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
  },

  get(id: string) {
    return simulate(store.find((r) => r.id === id) ?? null);
  },

  updateStatus(id: string, status: OrderStatus) {
    store = store.map((r) => (r.id === id ? { ...r, status } : r));
    return simulate(store.find((r) => r.id === id)!);
  },
};
