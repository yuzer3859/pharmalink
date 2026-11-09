import { useQuery } from '@tanstack/react-query';
import { ordersService, type OrderFilters } from '@/services/orders.service';
import { qk } from '@/lib/queryClient';
import { useAuth } from '@/context/AuthContext';

/**
 * The mock order list the pharmacy dashboard still reads. The Orders page uses the real API since
 * Work 108 (`usePharmacyOrders`); this goes with the mock seed when the dashboard moves to real
 * data (Work 114).
 */
export function useOrders(filters: OrderFilters) {
  const { scope } = useAuth();
  return useQuery({
    queryKey: qk.orders(scope, filters),
    queryFn: () => ordersService.list(scope!, filters),
    enabled: !!scope,
  });
}
