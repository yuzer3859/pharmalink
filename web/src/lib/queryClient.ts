import { QueryClient } from '@tanstack/react-query';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 5 * 60_000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
    mutations: {
      retry: 0,
    },
  },
});

// Centralised, type-safe query keys.
export const qk = {
  inventory: (scope: unknown, filters: unknown) => ['inventory', scope, filters] as const,
  inventoryCategories: () => ['inventory', 'categories'] as const,
  orders: (scope: unknown, filters: unknown) => ['orders', scope, filters] as const,
  order: (id: string) => ['orders', id] as const,
  staff: (scope: unknown, filters: unknown) => ['staff', scope, filters] as const,
  roles: (scope: unknown) => ['roles', scope] as const,
  pharmacies: (filters: unknown) => ['pharmacies', filters] as const,
  analytics: (scope: unknown) => ['analytics', scope] as const,
  reports: (scope: unknown) => ['reports', scope] as const,
  audit: (filters: unknown) => ['audit', filters] as const,
};
