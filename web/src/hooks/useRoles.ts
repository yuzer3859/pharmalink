import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { rolesService } from '@/services/roles.service';
import { qk } from '@/lib/queryClient';
import { useAuth } from '@/context/AuthContext';
import { useNotify } from '@/context/NotificationContext';
import type { Role } from '@/types';

export function useRoles() {
  const { scope } = useAuth();
  return useQuery({
    queryKey: qk.roles(scope),
    queryFn: () => rolesService.list(scope!),
    enabled: !!scope,
  });
}

export function useRoleMutations() {
  const qc = useQueryClient();
  const notify = useNotify();
  const invalidate = () => qc.invalidateQueries({ queryKey: ['roles'] });

  const create = useMutation({
    mutationFn: (input: Omit<Role, 'id' | 'memberCount' | 'isSystem'>) =>
      rolesService.create(input),
    onSuccess: () => {
      invalidate();
      notify('Role created');
    },
  });

  const update = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Partial<Role> }) =>
      rolesService.update(id, patch),
    onSuccess: () => {
      invalidate();
      notify('Role updated');
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => rolesService.remove(id),
    onSuccess: () => {
      invalidate();
      notify('Role deleted', 'info');
    },
  });

  return { create, update, remove };
}
