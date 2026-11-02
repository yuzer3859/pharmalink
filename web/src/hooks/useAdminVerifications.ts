import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  adminVerificationsService,
  verificationErrorMessage,
  type ApprovalInput,
  type VerificationFilters,
} from '@/services/adminVerifications.service';
import { useNotify } from '@/context/NotificationContext';

export function useVerificationQueue(filters: VerificationFilters) {
  return useQuery({
    queryKey: ['admin-verifications', filters] as const,
    queryFn: () => adminVerificationsService.list(filters),
    placeholderData: keepPreviousData,
  });
}

export function useVerification(id: string | null) {
  return useQuery({
    queryKey: ['admin-verifications', 'detail', id] as const,
    queryFn: () => adminVerificationsService.get(id as string),
    enabled: !!id,
  });
}

export function useVerificationDecisions(onDone: () => void) {
  const qc = useQueryClient();
  const notify = useNotify();
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['admin-verifications'] });
    // An approved pharmacy licence changes what the Pharmacies page reports.
    qc.invalidateQueries({ queryKey: ['pharmacies'] });
  };
  return {
    approve: useMutation({
      mutationFn: ({ id, input }: { id: string; input: ApprovalInput }) => adminVerificationsService.approve(id, input),
      onSuccess: (decision) => {
        refresh();
        notify(
          decision.type === 'PHARMACY_LICENSE'
            ? 'Licence approved: the organisation is active. Activate the pharmacy separately on the Pharmacies page.'
            : 'Verification approved.',
        );
        onDone();
      },
      onError: (error) => notify(verificationErrorMessage(error, 'The request could not be approved.'), 'error'),
    }),
    reject: useMutation({
      mutationFn: ({ id, reason }: { id: string; reason: string }) => adminVerificationsService.reject(id, reason),
      onSuccess: () => {
        refresh();
        notify('Verification rejected.');
        onDone();
      },
      onError: (error) => notify(verificationErrorMessage(error, 'The request could not be rejected.'), 'error'),
    }),
  };
}
