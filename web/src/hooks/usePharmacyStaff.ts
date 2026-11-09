import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNotify } from '@/context/NotificationContext';
import { ApiError } from '@/services/apiClient';
import { pharmacyStaffService } from '@/services/pharmacyStaff.service';

const KEY = ['pharmacy-staff'] as const;

export function staffErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError && error.status === 409) return 'They already hold that role at your pharmacy.';
  if (error instanceof ApiError && (error.status === 403 || error.status === 404)) return error.message || fallback;
  if (error instanceof ApiError) return `${error.message}${error.requestId ? ` (request ${error.requestId})` : ''}`;
  return fallback;
}

export function usePharmacyStaff() {
  return useQuery({ queryKey: KEY, queryFn: () => pharmacyStaffService.list() });
}

export function useStaffActions() {
  const qc = useQueryClient();
  const notify = useNotify();
  const settle = () => qc.invalidateQueries({ queryKey: KEY });
  return {
    add: useMutation({
      mutationFn: ({ email, roleKey }: { email: string; roleKey: string }) => pharmacyStaffService.add(email, roleKey),
      onSuccess: () => notify('Role given. They see it the next time they sign in to the portal.'),
      onError: (error) => notify(staffErrorMessage(error, 'The role could not be given.'), 'error'),
      onSettled: settle,
    }),
    removeRole: useMutation({
      mutationFn: ({ userId, roleKey }: { userId: string; roleKey: string }) => pharmacyStaffService.removeRole(userId, roleKey),
      onSuccess: () => notify('Role removed.', 'info'),
      onError: (error) => notify(staffErrorMessage(error, 'The role could not be removed.'), 'error'),
      onSettled: settle,
    }),
  };
}
