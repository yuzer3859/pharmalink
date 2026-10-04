import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { staffService, type StaffFilters } from '@/services/staff.service';
import { qk } from '@/lib/queryClient';
import { useAuth } from '@/context/AuthContext';
import { useNotify } from '@/context/NotificationContext';
import type { StaffMember } from '@/types';

export function useStaff(filters: StaffFilters) {
  const { scope } = useAuth();
  return useQuery({
    queryKey: qk.staff(scope, filters),
    queryFn: () => staffService.list(scope!, filters),
    enabled: !!scope,
  });
}

export function useStaffMutations() {
  const qc = useQueryClient();
  const notify = useNotify();
  const invalidate = () => qc.invalidateQueries({ queryKey: ['staff'] });

  const create = useMutation({
    mutationFn: (input: Omit<StaffMember, 'id' | 'createdAt' | 'lastActiveAt'>) =>
      staffService.create(input),
    onSuccess: () => {
      invalidate();
      notify('Staff member invited');
    },
  });

  const update = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Partial<StaffMember> }) =>
      staffService.update(id, patch),
    onSuccess: () => {
      invalidate();
      notify('Staff member updated');
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => staffService.remove(id),
    onSuccess: () => {
      invalidate();
      notify('Staff member removed', 'info');
    },
  });

  return { create, update, remove };
}
