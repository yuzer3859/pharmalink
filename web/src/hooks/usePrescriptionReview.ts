import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNotify } from '@/context/NotificationContext';
import { ApiError } from '@/services/apiClient';
import { prescriptionReviewService, type Approval } from '@/services/prescriptionReview.service';

const KEY = ['prescription-review'] as const;

export function useReviewQueue(page: number, size: number) {
  return useQuery({
    queryKey: [...KEY, 'queue', page, size] as const,
    queryFn: () => prescriptionReviewService.queue(page, size),
    placeholderData: keepPreviousData,
    // Prescriptions arrive when customers open checkout; a short refresh keeps the queue current.
    refetchInterval: 15_000,
  });
}

export function useReviewPrescription(id: string | null) {
  return useQuery({
    queryKey: [...KEY, 'detail', id] as const,
    queryFn: () => prescriptionReviewService.get(id as string),
    enabled: !!id,
  });
}

export function reviewErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError && error.status === 403) return 'Only a pharmacist of the pharmacy this prescription was sent to can review it.';
  if (error instanceof ApiError && error.status === 409) return 'This prescription changed meanwhile. It has been refreshed; check its status.';
  if (error instanceof ApiError) return `${error.message}${error.requestId ? ` (request ${error.requestId})` : ''}`;
  return fallback;
}

type Decision =
  | { id: string; kind: 'approve'; approval: Approval }
  | { id: string; kind: 'reject'; reason: string }
  | { id: string; kind: 'clarify'; message: string };

const DONE = {
  approve: 'Prescription approved. The customer can now pay and order from your pharmacy.',
  reject: 'Prescription rejected. The customer has been told why.',
  clarify: 'Clarification requested. The customer can upload a clearer prescription.',
} as const;

export function useReviewDecision() {
  const qc = useQueryClient();
  const notify = useNotify();
  return useMutation({
    mutationFn: (decision: Decision) => {
      switch (decision.kind) {
        case 'approve':
          return prescriptionReviewService.approve(decision.id, decision.approval);
        case 'reject':
          return prescriptionReviewService.reject(decision.id, decision.reason);
        case 'clarify':
          return prescriptionReviewService.clarify(decision.id, decision.message);
      }
    },
    onSuccess: (_r, decision) => notify(DONE[decision.kind]),
    onError: (error) => notify(reviewErrorMessage(error, 'The decision could not be recorded.'), 'error'),
    onSettled: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}
