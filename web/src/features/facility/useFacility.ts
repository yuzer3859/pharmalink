import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNotify } from '@/context/NotificationContext';
import { ApiError } from '@/services/apiClient';
import { facilityPortalService } from '@/services/facilityPortal.service';

export const FACILITY_PROFILE_KEY = ['facility', 'profile'] as const;

/** Work 164: the facility the portal works in (chosen with the switcher when there are several). */
export function useFacilityProfile() {
  return useQuery({ queryKey: FACILITY_PROFILE_KEY, queryFn: () => facilityPortalService.profile() });
}

/** The server's words for a refused change, else the fallback. */
export function facilityErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    if (error.code === 'PROVIDER_SUSPENDED') return 'Your facility is disabled by PharmaLink, so it cannot be changed. Contact PharmaLink support.';
    if (error.code === 'ADDRESS_OUTSIDE_ETHIOPIA') return 'The map position must be in Ethiopia.';
    return error.message || fallback;
  }
  return fallback;
}

/** A change to the facility, then the profile is read again and the person told. */
export function useFacilityChange<T>(run: (input: T) => Promise<unknown>, done: string) {
  const qc = useQueryClient();
  const notify = useNotify();
  return useMutation({
    mutationFn: run,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: FACILITY_PROFILE_KEY });
      notify(done);
    },
    onError: (error) => notify(facilityErrorMessage(error, 'The change could not be saved.'), 'error'),
  });
}
