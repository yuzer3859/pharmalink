import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ApiError } from '@/services/apiClient';
import { pharmacyDashboardService } from '@/services/pharmacyDashboard.service';

export function dashboardErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError && error.status === 403) return 'Your account is not allowed to see this.';
  if (error instanceof ApiError) return `${error.message}${error.requestId ? ` (request ${error.requestId})` : ''}`;
  return fallback;
}

export function usePharmacyDashboard() {
  return useQuery({ queryKey: ['pharmacy-dashboard'], queryFn: () => pharmacyDashboardService.dashboard(), refetchInterval: 60_000 });
}

export function useStatements(filters: { status?: string; page: number; size: number }) {
  return useQuery({
    queryKey: ['pharmacy-statements', filters] as const,
    queryFn: () => pharmacyDashboardService.statements(filters),
    placeholderData: keepPreviousData,
  });
}

export function useStatement(id: string | null) {
  return useQuery({ queryKey: ['pharmacy-statements', 'detail', id] as const, queryFn: () => pharmacyDashboardService.statement(id as string), enabled: !!id });
}
