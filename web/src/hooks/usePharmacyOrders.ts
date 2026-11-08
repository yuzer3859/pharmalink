import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNotify } from '@/context/NotificationContext';
import { ApiError } from '@/services/apiClient';
import {
  pharmacyOrdersService,
  type FulfillmentAction,
  type PharmacyOrderFilters,
} from '@/services/pharmacyOrders.service';

const KEY = ['pharmacy-orders'] as const;

export function usePharmacyOrders(filters: PharmacyOrderFilters) {
  return useQuery({
    queryKey: [...KEY, filters] as const,
    queryFn: () => pharmacyOrdersService.list(filters),
    placeholderData: keepPreviousData,
    // New orders arrive without a push channel; a short refresh keeps the queue current.
    refetchInterval: 15_000,
  });
}

export function usePharmacyOrder(fulfillmentId: string | null) {
  return useQuery({
    queryKey: [...KEY, 'detail', fulfillmentId] as const,
    queryFn: () => pharmacyOrdersService.get(fulfillmentId as string),
    enabled: !!fulfillmentId,
    refetchInterval: 15_000,
  });
}

const DONE: Record<FulfillmentAction, string> = {
  accept: 'Order accepted.',
  decline: 'Order declined. PharmaLink will look for another pharmacy.',
  prepare: 'Preparing the order.',
  ready: 'Marked ready. A driver is being found.',
};

export function actionErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 403) return 'Your account is not allowed to fulfil orders.';
  if (error instanceof ApiError && error.status === 409) return 'This order changed meanwhile. It has been refreshed; check its status and try again.';
  if (error instanceof ApiError) return `${error.message}${error.requestId ? ` (request ${error.requestId})` : ''}`;
  return 'The action could not be completed.';
}

export function useFulfillmentAction() {
  const qc = useQueryClient();
  const notify = useNotify();
  return useMutation({
    mutationFn: ({ id, action, reason }: { id: string; action: FulfillmentAction; reason?: string }) => {
      switch (action) {
        case 'accept':
          return pharmacyOrdersService.accept(id);
        case 'prepare':
          return pharmacyOrdersService.prepare(id);
        case 'ready':
          return pharmacyOrdersService.ready(id);
        case 'decline':
          return pharmacyOrdersService.decline(id, reason ?? '');
      }
    },
    onSuccess: (_result, { action }) => notify(DONE[action]),
    onError: (error) => notify(actionErrorMessage(error), 'error'),
    onSettled: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}
