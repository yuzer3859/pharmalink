import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { auditService, type AuditFilters } from '@/services/audit.service';
import { qk } from '@/lib/queryClient';

export function useAudit(filters: AuditFilters) {
  return useQuery({
    queryKey: qk.audit(filters),
    queryFn: () => auditService.list(filters),
    // Keep the current page on screen while the next one loads.
    placeholderData: keepPreviousData,
  });
}
