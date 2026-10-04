import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ordersService, type OrderFilters } from '@/services/orders.service';
import { qk } from '@/lib/queryClient';
import { useAuth } from '@/context/AuthContext';
import { useNotify } from '@/context/NotificationContext';
import type { OrderStatus } from '@/types';

export function useOrders(filters: OrderFilters) {
  const { scope } = useAuth();
  return useQuery({
    queryKey: qk.orders(scope, filters),
    queryFn: () => ordersService.list(scope!, filters),
    enabled: !!scope,
  });
}

export function useOrder(id: string | null) {
  return useQuery({
    queryKey: qk.order(id ?? ''),
    queryFn: () => ordersService.get(id!),
    enabled: !!id,
  });
}

export function useOrderStatusMutation() {
  const qc = useQueryClient();
  const notify = useNotify();
  return useMutation({
    mutationFn: ({ id, status }: { id: string; status: OrderStatus }) =>
      ordersService.updateStatus(id, status),
    onSuccess: (order) => {
      qc.invalidateQueries({ queryKey: ['orders'] });
      notify(`Order ${order.reference} → ${order.status}`);
    },
  });
}
