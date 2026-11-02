import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { activationErrorMessage, pharmaciesService, type PharmacyFilters } from '@/services/pharmacies.service';
import { qk } from '@/lib/queryClient';
import { useNotify } from '@/context/NotificationContext';

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
