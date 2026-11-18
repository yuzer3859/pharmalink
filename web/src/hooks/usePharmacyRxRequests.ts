import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNotify } from '@/context/NotificationContext';
import { ApiError } from '@/services/apiClient';
import { pharmacyRxRequestsService, type QuoteInput } from '@/services/pharmacyRxRequests.service';

const KEY = ['pharmacy-rx-requests'] as const;

/** Requests arrive without a push channel to the portal; a short refresh keeps the list current. */
const REFRESH_MS = 10_000;

export function usePharmacyRxRequests(scope: 'active' | 'all', page: number, size: number) {
  return useQuery({
    queryKey: [...KEY, scope, page, size] as const,
    queryFn: () => pharmacyRxRequestsService.list(scope, page, size),
    placeholderData: keepPreviousData,
    refetchInterval: REFRESH_MS,
  });
}

export function usePharmacyRxRequest(id: string | null) {
  return useQuery({
    queryKey: [...KEY, 'detail', id] as const,
    queryFn: () => pharmacyRxRequestsService.get(id as string),
    enabled: !!id,
    refetchInterval: REFRESH_MS,
  });
}

export function rxRequestErrorMessage(error: unknown, fallback = 'The action could not be completed.'): string {
  if (error instanceof ApiError && error.code === 'RX_REQUEST_UNAVAILABLE') return 'This request is no longer available: another pharmacy accepted it, or it ended.';
  if (error instanceof ApiError && error.code === 'PRESCRIPTION_TOO_OLD') return error.message;
  if (error instanceof ApiError && error.status === 403) return 'Only a pharmacist of your pharmacy can do this.';
  if (error instanceof ApiError) return `${error.message}${error.requestId ? ` (request ${error.requestId})` : ''}`;
  return fallback;
}

export type RxRequestDecision =
  | { id: string; kind: 'accept' }
  | { id: string; kind: 'decline'; reason: string }
  | { id: string; kind: 'release'; reason: string }
  | { id: string; kind: 'quote'; quote: QuoteInput };

const DONE: Record<RxRequestDecision['kind'], string> = {
  accept: 'Accepted. The request is yours: send the medicines and price before the time runs out.',
  decline: 'Declined. The request stays with the other pharmacies.',
  release: 'Let go. The request is offered to the other pharmacies again.',
  quote: 'Quote sent. The customer has been told and can confirm it.',
};

export function useRxRequestDecision() {
  const qc = useQueryClient();
  const notify = useNotify();
  return useMutation({
    mutationFn: (d: RxRequestDecision) => {
      switch (d.kind) {
        case 'accept':
          return pharmacyRxRequestsService.accept(d.id);
        case 'decline':
          return pharmacyRxRequestsService.decline(d.id, d.reason);
        case 'release':
          return pharmacyRxRequestsService.release(d.id, d.reason);
        case 'quote':
          return pharmacyRxRequestsService.quote(d.id, d.quote);
      }
    },
    onSuccess: (_r, d) => notify(DONE[d.kind]),
    onError: (error) => notify(rxRequestErrorMessage(error), 'error'),
    onSettled: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}
