import type { Pharmacy } from '@/types';
import { PHARMACIES } from './mock/seed';
import { simulate } from './apiClient';

let store: Pharmacy[] = [...PHARMACIES];

export interface PharmacyFilters {
  search?: string;
  status?: Pharmacy['status'] | 'all';
}

export const pharmaciesService = {
  list(filters: PharmacyFilters = {}) {
    let rows = store;
    if (filters.status && filters.status !== 'all') {
      rows = rows.filter((r) => r.status === filters.status);
    }
    if (filters.search) {
      const q = filters.search.toLowerCase();
      rows = rows.filter(
        (r) => r.name.toLowerCase().includes(q) || r.city.toLowerCase().includes(q),
      );
    }
    return simulate(rows);
  },

  updateStatus(id: string, status: Pharmacy['status']) {
    store = store.map((r) => (r.id === id ? { ...r, status } : r));
    return simulate(store.find((r) => r.id === id)!);
  },
};
