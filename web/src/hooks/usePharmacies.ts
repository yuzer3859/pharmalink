import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { activationErrorMessage, pharmaciesService, type PharmacyFilters } from '@/services/pharmacies.service';
import { qk } from '@/lib/queryClient';
import { useNotify } from '@/context/NotificationContext';
import { adminVerificationsService } from '@/services/adminVerifications.service';
import { auditService } from '@/services/audit.service';

export function usePharmacies(filters: PharmacyFilters) {
  return useQuery({
    queryKey: qk.pharmacies(filters),
    queryFn: () => pharmaciesService.list(filters),
    placeholderData: keepPreviousData,
  });
}

export function useActivatePharmacy() {
  const qc = useQueryClient();
  const notify = useNotify();
  return useMutation({
    mutationFn: (pharmacyId: string) => pharmaciesService.activate(pharmacyId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['pharmacies'] });
      notify('Pharmacy activated.');
    },
    onError: (error) => notify(activationErrorMessage(error), 'error'),
  });
}

// ---- Work 153: the pharmacy record ---------------------------------------------------------------

/** The pharmacy itself, its people, its licence files (with each request's documents) and history. */
export function usePharmacyRecord(pharmacyId: string | null, organizationId: string | null) {
  const enabled = !!pharmacyId;
  const pharmacy = useQuery({ queryKey: ['pharmacies', 'one', pharmacyId], queryFn: () => pharmaciesService.get(pharmacyId as string), enabled });
  const people = useQuery({ queryKey: ['pharmacies', 'people', pharmacyId], queryFn: () => pharmaciesService.people(pharmacyId as string), enabled, retry: false });
  const files = useQuery({
    queryKey: ['pharmacies', 'files', organizationId],
    enabled: !!organizationId,
    retry: false,
    queryFn: async () => {
      const page = await adminVerificationsService.list({ organizationId: organizationId as string, status: 'all', size: 50 });
      return Promise.all(page.items.map((item) => adminVerificationsService.get(item.requestId)));
    },
  });
  const history = useQuery({
    queryKey: ['pharmacies', 'history', pharmacyId],
    enabled,
    retry: false,
    queryFn: () => auditService.list({ resourceType: 'Pharmacy', resourceId: pharmacyId as string, size: 25 }),
  });
  return { pharmacy, people, files, history };
}

export function useSuspendPharmacy(onDone?: () => void) {
  const qc = useQueryClient();
  const notify = useNotify();
  return useMutation({
    mutationFn: ({ pharmacyId, reason }: { pharmacyId: string; reason: string }) => pharmaciesService.suspend(pharmacyId, reason),
    onSuccess: (result) => {
      qc.invalidateQueries({ queryKey: ['pharmacies'] });
      notify(result.changed ? 'Pharmacy disabled. Customers can no longer see or buy from it, and its owner has been told.' : 'This pharmacy was already disabled.');
      onDone?.();
    },
    onError: (error) => notify(error instanceof Error ? error.message : 'The pharmacy could not be disabled.', 'error'),
  });
}
