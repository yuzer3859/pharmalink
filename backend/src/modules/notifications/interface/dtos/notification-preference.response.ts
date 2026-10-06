import { CategoryPreferences } from '../../application/queries/get-notification-preferences.query';

/** One channel's effective preference. No row id, owner or timestamp is exposed. */
export interface ChannelPreferenceResponse {
  channel: string;
  enabled: boolean;
  digestFrequency: string;
  /** `false` for `IN_APP`, which is always on. */
  configurable: boolean;
  /** `POLICY` (fixed), `STORED` (the user chose it) or `DEFAULT` (nothing stored). */
  source: string;
}

export interface CategoryPreferencesResponse {
  category: string;
  channels: ChannelPreferenceResponse[];
}

export interface NotificationPreferencesResponse {
  categories: CategoryPreferencesResponse[];
}

// Explicit allow-list, never a spread.
export function toCategoryPreferencesResponse(c: CategoryPreferences): CategoryPreferencesResponse {
  return {
    category: c.category,
    channels: c.channels.map((p) => ({
      channel: p.channel,
      enabled: p.enabled,
      digestFrequency: p.digestFrequency,
      configurable: p.configurable,
      source: p.source,
    })),
  };
}
