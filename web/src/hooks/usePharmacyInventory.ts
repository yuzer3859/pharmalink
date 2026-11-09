import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNotify } from '@/context/NotificationContext';
import { ApiError } from '@/services/apiClient';
import {
  pharmacyInventoryService as api,
  type NewBatch,
  type NewListing,
} from '@/services/pharmacyInventory.service';

const KEY = ['pharmacy-inventory'] as const;

export function inventoryErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError && error.status === 403) return 'Your account is not allowed to manage this pharmacy’s inventory.';
  if (error instanceof ApiError && error.code === 'PHARMACY_NOT_ELIGIBLE') return 'Your pharmacy is not active yet, so it cannot list products.';
  if (error instanceof ApiError) return `${error.message}${error.requestId ? ` (request ${error.requestId})` : ''}`;
  return fallback;
}

export function useListings(filters: { branchId?: string; page: number; size: number }) {
  return useQuery({ queryKey: [...KEY, 'list', filters] as const, queryFn: () => api.list(filters), placeholderData: keepPreviousData });
}

export function useListing(id: string | null) {
  return useQuery({ queryKey: [...KEY, 'detail', id] as const, queryFn: () => api.get(id as string), enabled: !!id });
}

export function useMovements(id: string | null) {
  return useQuery({ queryKey: [...KEY, 'movements', id] as const, queryFn: () => api.movements(id as string), enabled: !!id });
}

/** Branches need `pharmacy:manage:org`; without it the page falls back to the listings' own branches. */
export function useBranches() {
  return useQuery({ queryKey: [...KEY, 'branches'] as const, queryFn: () => api.branches(), retry: false });
}

export function useProductSearch(q: string) {
  const term = q.trim();
  return useQuery({
    queryKey: [...KEY, 'catalog', term] as const,
    queryFn: () => api.searchProducts(term),
    enabled: term.length >= 2,
    staleTime: 60_000,
  });
}

export function useInventoryActions() {
  const qc = useQueryClient();
  const notify = useNotify();
  const settle = () => qc.invalidateQueries({ queryKey: KEY });
  const fail = (fallback: string) => (error: unknown) => notify(inventoryErrorMessage(error, fallback), 'error');
  return {
    create: useMutation({
      mutationFn: (input: NewListing) => api.create(input),
      onSuccess: () => notify('Product listed. It is sellable once enabled with stock.'),
      onError: fail('The product could not be listed.'),
      onSettled: settle,
    }),
    update: useMutation({
      mutationFn: ({ id, patch }: { id: string; patch: { priceBirr?: number; isEnabled?: boolean } }) => api.update(id, patch),
      onSuccess: () => notify('Listing updated.'),
      onError: fail('The listing could not be updated.'),
      onSettled: settle,
    }),
    remove: useMutation({
      mutationFn: (id: string) => api.remove(id),
      onSuccess: () => notify('Listing removed.', 'info'),
      onError: fail('The listing could not be removed.'),
      onSettled: settle,
    }),
    receive: useMutation({
      mutationFn: ({ id, batch }: { id: string; batch: NewBatch }) => api.receive(id, batch),
      onSuccess: () => notify('Stock received.'),
      onError: fail('The stock could not be received.'),
      onSettled: settle,
    }),
    adjust: useMutation({
      mutationFn: ({ batchId, quantityDelta, reason }: { batchId: string; quantityDelta: number; reason: string }) => api.adjust(batchId, quantityDelta, reason),
      onSuccess: () => notify('Stock adjusted.'),
      onError: fail('The stock could not be adjusted.'),
      onSettled: settle,
    }),
  };
}
