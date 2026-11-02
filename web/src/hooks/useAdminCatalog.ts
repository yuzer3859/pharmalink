import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { adminCatalogService, catalogErrorMessage, type CatalogAction, type CatalogReviewFilters } from '@/services/adminCatalog.service';
import { useNotify } from '@/context/NotificationContext';

export function useCatalogReview(filters: CatalogReviewFilters) {
  return useQuery({
    queryKey: ['admin-catalog', filters] as const,
    queryFn: () => adminCatalogService.list(filters),
    placeholderData: keepPreviousData,
  });
}

export function useCatalogSummary() {
  return useQuery({ queryKey: ['admin-catalog', 'summary'] as const, queryFn: () => adminCatalogService.summary() });
}

export function useCatalogHistory(id: string | null) {
  return useQuery({
    queryKey: ['admin-catalog', 'history', id] as const,
    queryFn: () => adminCatalogService.history(id as string),
    enabled: !!id,
  });
}

const DONE: Record<CatalogAction, string> = {
  submit: 'Submitted for review.',
  approve: 'Approved: the product is now active in the catalogue.',
  reject: 'Rejected.',
  resubmit: 'Returned to the review queue.',
};

export function useCatalogDecision(onDone: () => void) {
  const qc = useQueryClient();
  const notify = useNotify();
  return useMutation({
    mutationFn: ({ id, action, reason }: { id: string; action: CatalogAction; reason?: string }) =>
      action === 'reject' ? adminCatalogService.reject(id, reason ?? '') : adminCatalogService[action](id),
    onSuccess: (_result, { action }) => {
      qc.invalidateQueries({ queryKey: ['admin-catalog'] });
      notify(DONE[action]);
      onDone();
    },
    onError: (error) => notify(catalogErrorMessage(error, 'The decision could not be recorded.'), 'error'),
  });
}
