import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { adminConfigService, configErrorMessage } from '@/services/adminConfig.service';
import { useNotify } from '@/context/NotificationContext';
import type { ConfigValueType } from '@/types';

export function useConfigSettings() {
  return useQuery({ queryKey: ['admin-config'] as const, queryFn: () => adminConfigService.list() });
}

export function useConfigHistory(namespace: string | null, key: string | null) {
  return useQuery({
    queryKey: ['admin-config', 'history', namespace, key] as const,
    queryFn: () => adminConfigService.history(namespace as string, key as string),
    enabled: !!namespace && !!key,
  });
}

export function useFeatureFlags() {
  return useQuery({ queryKey: ['admin-flags'] as const, queryFn: () => adminConfigService.flags() });
}

export function useConfigActions() {
  const qc = useQueryClient();
  const notify = useNotify();
  const refresh = () => qc.invalidateQueries({ queryKey: ['admin-config'] });
  return {
    update: useMutation({
      mutationFn: (v: { namespace: string; key: string; valueType: ConfigValueType; value: unknown; reason?: string }) =>
        adminConfigService.update(v.namespace, v.key, v.valueType, v.value, v.reason),
      onSuccess: (result) => {
        refresh();
        notify(`Published version ${result.config.version}.`);
      },
      onError: (error) => notify(configErrorMessage(error, 'The setting could not be changed.'), 'error'),
    }),
    rollback: useMutation({
      mutationFn: (v: { namespace: string; key: string; toVersion: number; reason?: string }) =>
        adminConfigService.rollback(v.namespace, v.key, v.toVersion, v.reason),
      onSuccess: (result) => {
        refresh();
        notify(`Restored as version ${result.config.version}.`);
      },
      onError: (error) => notify(configErrorMessage(error, 'The setting could not be rolled back.'), 'error'),
    }),
    toggleFlag: useMutation({
      mutationFn: (v: { key: string; enabled: boolean }) => adminConfigService.toggleFlag(v.key, v.enabled),
      onSuccess: (result) => {
        qc.invalidateQueries({ queryKey: ['admin-flags'] });
        notify(result.changed ? `${result.flag.key} turned ${result.flag.enabled ? 'on' : 'off'}.` : 'No change.');
      },
      onError: (error) => notify(configErrorMessage(error, 'The flag could not be changed.'), 'error'),
    }),
    createFlag: useMutation({
      mutationFn: (v: { key: string; enabled: boolean; description?: string }) =>
        adminConfigService.createFlag(v.key, v.enabled, v.description),
      onSuccess: (result) => {
        qc.invalidateQueries({ queryKey: ['admin-flags'] });
        notify(result.created ? `${result.flag.key} added (${result.flag.enabled ? 'on' : 'off'}).` : `${result.flag.key} already existed; no change.`);
      },
      onError: (error) => notify(configErrorMessage(error, 'The flag could not be added.'), 'error'),
    }),
  };
}
