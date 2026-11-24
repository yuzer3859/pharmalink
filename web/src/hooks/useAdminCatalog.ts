import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { adminCatalogService, catalogErrorMessage, type CatalogAction, type CatalogReviewFilters, type PictureSuggestionStatus } from '@/services/adminCatalog.service';
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

/** Work 150: a product's saved pictures. */
export function useCatalogPictures(id: string | null) {
  return useQuery({
    queryKey: ['admin-catalog', 'pictures', id] as const,
    queryFn: () => adminCatalogService.pictures(id as string),
    enabled: !!id,
  });
}

export function useSavePictures() {
  const qc = useQueryClient();
  const notify = useNotify();
  return useMutation({
    mutationFn: ({ id, images }: { id: string; images: string[] }) => adminCatalogService.savePictures(id, images),
    onSuccess: (_result, { id }) => {
      qc.invalidateQueries({ queryKey: ['admin-catalog', 'pictures', id] });
      notify('Pictures saved. Customers see them now.');
    },
    onError: (error) => notify(catalogErrorMessage(error, 'The pictures could not be saved.'), 'error'),
  });
}

/** Work 151: pictures pharmacies suggested, waiting ones by default. */
export function usePictureSuggestions(filters: { status?: PictureSuggestionStatus; page?: number; size?: number }) {
  return useQuery({
    queryKey: ['admin-catalog', 'picture-suggestions', filters] as const,
    queryFn: () => adminCatalogService.pictureSuggestions(filters),
    placeholderData: keepPreviousData,
  });
}

export function useDecidePictureSuggestion() {
  const qc = useQueryClient();
  const notify = useNotify();
  return useMutation({
    mutationFn: (input: { id: string; approve: true } | { id: string; approve: false; reason: string }) =>
      input.approve ? adminCatalogService.approvePictureSuggestion(input.id) : adminCatalogService.rejectPictureSuggestion(input.id, input.reason),
    onSuccess: (_r, input) => notify(input.approve ? 'Picture added. Customers see it now.' : 'Picture turned down. The pharmacy sees your reason.'),
    onError: (error) => notify(catalogErrorMessage(error, 'The picture could not be decided.'), 'error'),
    onSettled: () => qc.invalidateQueries({ queryKey: ['admin-catalog'] }),
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
