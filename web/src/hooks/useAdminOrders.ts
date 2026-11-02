import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { adminOrdersService, type AdminOrderFilters } from '@/services/adminOrders.service';

export function useAdminOrders(filters: AdminOrderFilters) {
  return useQuery({
    queryKey: ['admin-orders', filters] as const,
    queryFn: () => adminOrdersService.list(filters),
    placeholderData: keepPreviousData,
  });
}

export function useAdminOrder(orderId: string | null) {
  return useQuery({
    queryKey: ['admin-orders', 'detail', orderId] as const,
    queryFn: () => adminOrdersService.get(orderId as string),
    enabled: !!orderId,
  });
}
