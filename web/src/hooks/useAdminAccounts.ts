import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { accountErrorMessage, adminAccountsService, type AdminAccountFilters } from '@/services/adminAccounts.service';
import { useNotify } from '@/context/NotificationContext';

export function useAdminAccounts(filters: AdminAccountFilters) {
  return useQuery({
    queryKey: ['admin-accounts', filters] as const,
    queryFn: () => adminAccountsService.list(filters),
    placeholderData: keepPreviousData,
  });
}

export function useAdminAccount(userId: string | null) {
  return useQuery({
    queryKey: ['admin-accounts', 'detail', userId] as const,
    queryFn: () => adminAccountsService.get(userId as string),
    enabled: !!userId,
  });
}

export function useRoleCatalogue(enabled = true) {
  return useQuery({
    queryKey: ['admin-roles'] as const,
    queryFn: () => adminAccountsService.roles(),
    enabled,
    staleTime: 5 * 60_000,
  });
}

/** Account changes: each refreshes the list and the open account, and reports the outcome. */
export function useAccountActions() {
  const qc = useQueryClient();
  const notify = useNotify();
  const refresh = () => qc.invalidateQueries({ queryKey: ['admin-accounts'] });
  const onError = (fallback: string) => (error: unknown) => notify(accountErrorMessage(error, fallback), 'error');

  return {
    suspend: useMutation({
      mutationFn: ({ userId, reason }: { userId: string; reason: string }) => adminAccountsService.suspend(userId, reason),
      onSuccess: () => {
        refresh();
        notify('Account suspended. Its sessions were revoked.');
      },
      onError: onError('The account could not be suspended.'),
    }),
    reinstate: useMutation({
      mutationFn: ({ userId, reason }: { userId: string; reason?: string }) => adminAccountsService.reinstate(userId, reason),
      onSuccess: () => {
        refresh();
        notify('Account reinstated.');
      },
      onError: onError('The account could not be reinstated.'),
    }),
    assignRole: useMutation({
      mutationFn: ({ userId, roleKey, organizationId }: { userId: string; roleKey: string; organizationId?: string }) =>
        adminAccountsService.assignRole(userId, roleKey, organizationId),
      onSuccess: () => {
        refresh();
        notify('Role assigned.');
      },
      onError: onError('The role could not be assigned.'),
    }),
    revokeRole: useMutation({
      mutationFn: ({ userId, assignmentId }: { userId: string; assignmentId: string }) =>
        adminAccountsService.revokeRole(userId, assignmentId),
      onSuccess: () => {
        refresh();
        notify('Role revoked.');
      },
      onError: onError('The role could not be revoked.'),
    }),
  };
}
