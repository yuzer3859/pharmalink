import { useQuery } from '@tanstack/react-query';
import { analyticsService } from '@/services/analytics.service';
import { qk } from '@/lib/queryClient';
import { useAuth } from '@/context/AuthContext';

export function useAnalytics() {
  const { scope } = useAuth();
  return useQuery({
    queryKey: qk.analytics(scope),
    queryFn: () => analyticsService.bundle(scope!),
    enabled: !!scope,
  });
}
