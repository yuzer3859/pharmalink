import type { ConfigHistory, ConfigSetting, ConfigUpdate, ConfigValueType, FeatureFlag, FeatureFlagToggle } from '@/types';
import { ApiError } from './apiClient';
import { authService, type SessionRequest } from './auth.service';

/** The server's bound for a change reason and a flag description. */
export const MAX_CONFIG_REASON_LENGTH = 500;

export type ParsedValue = { ok: true; value: unknown } | { ok: false; error: string };

/**
 * Turns what an operator typed into the value `PUT /admin/config/:namespace/:key` expects for the
 * setting's declared type, or explains why it can't. Mirrors the catalogue's own checks (type,
 * range, allowed values) so mistakes are caught before sending; the server validates again.
 */
export function parseConfigInput(
  setting: Pick<ConfigSetting, 'valueType' | 'min' | 'max' | 'allowed'>,
  raw: string,
): ParsedValue {
  const text = raw.trim();
  switch (setting.valueType) {
    case 'BOOLEAN':
      if (text === 'true') return { ok: true, value: true };
      if (text === 'false') return { ok: true, value: false };
      return { ok: false, error: 'Choose true or false.' };
    case 'INTEGER':
    case 'DECIMAL': {
      const pattern = setting.valueType === 'INTEGER' ? /^-?\d+$/ : /^-?\d+(\.\d+)?$/;
      if (!pattern.test(text)) return { ok: false, error: setting.valueType === 'INTEGER' ? 'Enter a whole number.' : 'Enter a number.' };
      const value = Number(text);
      if (setting.min !== null && value < setting.min) return { ok: false, error: `Must be at least ${setting.min}.` };
      if (setting.max !== null && value > setting.max) return { ok: false, error: `Must be at most ${setting.max}.` };
      return { ok: true, value };
    }
    case 'STRING':
      if (!text) return { ok: false, error: 'Enter a value.' };
      if (setting.allowed && !setting.allowed.includes(text)) return { ok: false, error: `Must be one of: ${setting.allowed.join(', ')}.` };
      return { ok: true, value: text };
    case 'JSON':
      try {
        return { ok: true, value: JSON.parse(text) as unknown };
      } catch {
        return { ok: false, error: 'Enter valid JSON.' };
      }
    default:
      return { ok: false, error: 'Unknown value type.' };
  }
}

/** A stored value as editable text (the inverse of `parseConfigInput`). */
export function formatConfigValue(valueType: ConfigValueType, value: unknown): string {
  if (value === null || value === undefined) return '';
  if (valueType === 'JSON') return JSON.stringify(value, null, 2);
  return String(value);
}

export function configErrorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof ApiError)) return fallback;
  if (error.status === 403) return 'Your account is not allowed to change platform configuration.';
  if (error.status === 404) return 'That setting is not governable.';
  return `${error.message}${error.requestId ? ` (request ${error.requestId})` : ''}`;
}

const reasonBody = (reason?: string) => (reason?.trim() ? { reason: reason.trim() } : {});

export function createAdminConfigService(request: SessionRequest) {
  const setting = (namespace: string, key: string) => `/admin/config/${encodeURIComponent(namespace)}/${encodeURIComponent(key)}`;
  return {
    /** Every governable setting with its effective value and where it comes from. */
    list(): Promise<ConfigSetting[]> {
      return request<ConfigSetting[]>('/admin/config', { method: 'GET' });
    },

    history(namespace: string, key: string): Promise<ConfigHistory> {
      return request<ConfigHistory>(`${setting(namespace, key)}/history`, { method: 'GET' });
    },

    /** Publishes a new version; the previous one is kept. The actor comes from the session. */
    update(namespace: string, key: string, valueType: ConfigValueType, value: unknown, reason?: string): Promise<ConfigUpdate> {
      return request<ConfigUpdate>(setting(namespace, key), { method: 'PUT', body: { valueType, value, ...reasonBody(reason) } });
    },

    /** Brings an earlier version back as a new version. */
    rollback(namespace: string, key: string, toVersion: number, reason?: string): Promise<ConfigUpdate> {
      return request<ConfigUpdate>(`${setting(namespace, key)}/rollback`, { method: 'POST', body: { toVersion, ...reasonBody(reason) } });
    },

    flags(): Promise<FeatureFlag[]> {
      return request<FeatureFlag[]>('/admin/feature-flags', { method: 'GET' });
    },

    /** Idempotent on the server: asking for the current state changes nothing. */
    toggleFlag(key: string, enabled: boolean): Promise<FeatureFlagToggle> {
      return request<FeatureFlagToggle>(`/admin/feature-flags/${encodeURIComponent(key)}`, { method: 'PUT', body: { enabled } });
    },
  };
}

export const adminConfigService = createAdminConfigService(authService.request);
