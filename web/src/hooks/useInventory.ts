import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { inventoryService, type InventoryFilters } from '@/services/inventory.service';
import { qk } from '@/lib/queryClient';
import { useAuth } from '@/context/AuthContext';
import { useNotify } from '@/context/NotificationContext';
import type { InventoryItem } from '@/types';

export function useInventory(filters: InventoryFilters) {
  const { scope } = useAuth();
  return useQuery({
    queryKey: qk.inventory(scope, filters),
    queryFn: () => inventoryService.list(scope!, filters),
    enabled: !!scope,
  });
}

export function useInventoryCategories() {
  return useQuery({
    queryKey: qk.inventoryCategories(),
    queryFn: () => inventoryService.categories(),
  });
}

export function useInventoryMutations() {
  const qc = useQueryClient();
  const notify = useNotify();
  const invalidate = () => qc.invalidateQueries({ queryKey: ['inventory'] });

  const create = useMutation({
    mutationFn: (input: Omit<InventoryItem, 'id' | 'status' | 'updatedAt'>) =>
      inventoryService.create(input),
    onSuccess: () => {
      invalidate();
      notify('Product added to inventory');
    },
  });

  const update = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Partial<InventoryItem> }) =>
      inventoryService.update(id, patch),
    onSuccess: () => {
      invalidate();
      notify('Product updated');
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => inventoryService.remove(id),
    onSuccess: () => {
      invalidate();
      notify('Product removed', 'info');
    },
  });

  return { create, update, remove };
}
