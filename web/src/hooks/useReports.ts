import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { reportsService } from '@/services/reports.service';
import { qk } from '@/lib/queryClient';
import { useAuth } from '@/context/AuthContext';
import { useNotify } from '@/context/NotificationContext';
import type { ReportRecord } from '@/types';

export function useReports() {
  const { scope } = useAuth();
  return useQuery({
    queryKey: qk.reports(scope),
    queryFn: () => reportsService.list(scope!),
    enabled: !!scope,
  });
}

export function useReportTemplates() {
  return useQuery({
    queryKey: ['reports', 'templates'],
    queryFn: () => reportsService.templates(),
  });
}

export function useGenerateReport() {
  const qc = useQueryClient();
  const notify = useNotify();
  return useMutation({
    mutationFn: (input: {
      name: string;
      type: string;
      period: string;
      format: ReportRecord['format'];
    }) => reportsService.generate(input),
    onSuccess: () => {
      notify('Report queued for generation');
      qc.invalidateQueries({ queryKey: ['reports'] });
      // Refresh once the simulated generation completes.
      setTimeout(() => qc.invalidateQueries({ queryKey: ['reports'] }), 1800);
    },
  });
}
