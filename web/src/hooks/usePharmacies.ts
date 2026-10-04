import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { pharmaciesService, type PharmacyFilters } from '@/services/pharmacies.service';
import { qk } from '@/lib/queryClient';
import { useNotify } from '@/context/NotificationContext';
import type { Pharmacy } from '@/types';

export function usePharmacies(filters: PharmacyFilters) {
  return useQuery({
    queryKey: qk.pharmacies(filters),
    queryFn: () => pharmaciesService.list(filters),
  });
}

export function usePharmacyStatusMutation() {
  const qc = useQueryClient();
  const notify = useNotify();
  return useMutation({
    mutationFn: ({ id, status }: { id: string; status: Pharmacy['status'] }) =>
      pharmaciesService.updateStatus(id, status),
    onSuccess: (pharmacy) => {
      qc.invalidateQueries({ queryKey: ['pharmacies'] });
      notify(`${pharmacy.name} → ${pharmacy.status}`);
    },
  });
}
