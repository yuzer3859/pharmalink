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

export type RxReviewDecision =
  | { id: string; kind: 'approve'; legibilityOk: boolean; validityOk: boolean }
  | { id: string; kind: 'reject'; reason: string };

export function rxReviewErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 403) return 'Only a pharmacist of this pharmacy can review the prescription.';
  if (error instanceof ApiError && error.status === 409) return 'This order changed meanwhile. It has been refreshed; check its status.';
  if (error instanceof ApiError) return `${error.message}${error.requestId ? ` (request ${error.requestId})` : ''}`;
  return 'The decision could not be recorded.';
}

/** Work 137: the pharmacist's check of the original paper prescription the driver brought. */
export function usePaperDecision() {
  const qc = useQueryClient();
  const notify = useNotify();
  return useMutation({
    mutationFn: (d: { id: string; kind: 'verify' } | { id: string; kind: 'reject'; reason: string }) =>
      d.kind === 'verify' ? pharmacyOrdersService.verifyPaper(d.id) : pharmacyOrdersService.rejectPaper(d.id, d.reason),
    onSuccess: (_r, d) =>
      notify(d.kind === 'verify' ? 'Paper checked. You can prepare the order now.' : 'Paper rejected. The order is cancelled; give the paper back to the driver.'),
    onError: (error) => notify(rxReviewErrorMessage(error), 'error'),
    onSettled: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}

/** Work 132: the pharmacist's decision on the prescription of an order. */
export function useRxReviewDecision() {
  const qc = useQueryClient();
  const notify = useNotify();
  return useMutation({
    mutationFn: (decision: RxReviewDecision) =>
      decision.kind === 'approve'
        ? pharmacyOrdersService.approvePrescription(decision.id, { legibilityOk: decision.legibilityOk, validityOk: decision.validityOk })
        : pharmacyOrdersService.rejectPrescription(decision.id, decision.reason),
    onSuccess: (_r, decision) =>
      notify(
        decision.kind === 'approve'
          ? 'Prescription approved. A cash-on-delivery order is ready to accept; a prepaid one waits for the customer to pay.'
          : 'Prescription rejected. The order is cancelled and the customer has been told why.',
      ),
    onError: (error) => notify(rxReviewErrorMessage(error), 'error'),
    onSettled: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}
