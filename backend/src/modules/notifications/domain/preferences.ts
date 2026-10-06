import { DigestFrequency, NotificationCategory, NotificationChannel } from './enums';

/**
 * Notification preference policy (module-13 Work 11). The single authority for "may this user be
 * notified about this category on this channel": Module 13's `channel_preferences` table, one row
 * per (user, category, channel), read and written only through this module.
 *
 * ## What is configurable
 *
 * - **Categories** — the three the code-owned templates actually emit: `TRANSACTIONAL`,
 *   `SECURITY`, `SYSTEM`. `MessageCategory` also has `REMINDER` and `MARKETING`, but no template
 *   uses either, so a preference for them would govern nothing and is refused rather than stored.
 * - **Channels** — the delivery channels `PUSH`, `SMS` and `EMAIL`. `IN_APP` is not configurable:
 *   it is the notification center itself, which has always recorded every notification without
 *   consulting a preference, and a preference must not be able to make that record disappear.
 *   It is always reported enabled and a write naming it is refused.
 *
 * ## Precedence — the one rule a delivery channel applies
 *
 *     IN_APP            → enabled, IMMEDIATE (fixed by policy)
 *     a stored row      → the stored `enabled` / `digestFrequency`
 *     no row            → DEFAULT_CHANNEL_PREFERENCE
 *
 * The default is the table's own column defaults (`enabled true`, `digestFrequency IMMEDIATE`), so
 * an absent row and a row written with defaults mean the same thing and nothing is pre-seeded.
 */
export const CONFIGURABLE_CATEGORIES = [
  NotificationCategory.TRANSACTIONAL,
  NotificationCategory.SECURITY,
  NotificationCategory.SYSTEM,
] as const;
export type ConfigurableCategory = (typeof CONFIGURABLE_CATEGORIES)[number];

export const CONFIGURABLE_CHANNELS = [
  NotificationChannel.PUSH,
  NotificationChannel.SMS,
  NotificationChannel.EMAIL,
] as const;
export type ConfigurableChannel = (typeof CONFIGURABLE_CHANNELS)[number];

/** The channels reported for every category, in display order. */
export const REPORTED_CHANNELS = [NotificationChannel.IN_APP, ...CONFIGURABLE_CHANNELS] as const;

export interface ChannelPreferenceValue {
  enabled: boolean;
  digestFrequency: DigestFrequency;
}

/** `channel_preferences`' column defaults — what an absent row means. */
export const DEFAULT_CHANNEL_PREFERENCE: Readonly<ChannelPreferenceValue> = Object.freeze({
  enabled: true,
  digestFrequency: DigestFrequency.IMMEDIATE,
});

/** Where an effective preference came from. */
export enum PreferenceSource {
  /** Fixed by policy (`IN_APP`); not stored, not writable. */
  POLICY = 'POLICY',
  /** The user's stored row. */
  STORED = 'STORED',
  /** No row; `DEFAULT_CHANNEL_PREFERENCE`. */
  DEFAULT = 'DEFAULT',
}

export interface EffectiveChannelPreference extends ChannelPreferenceValue {
  channel: NotificationChannel;
  configurable: boolean;
  source: PreferenceSource;
}

export function isConfigurableCategory(category: string): category is ConfigurableCategory {
  return (CONFIGURABLE_CATEGORIES as readonly string[]).includes(category);
}

export function isConfigurableChannel(channel: string): channel is ConfigurableChannel {
  return (CONFIGURABLE_CHANNELS as readonly string[]).includes(channel);
}

/** The precedence rule above, for one channel. `stored` is the user's row, or `null`. */
export function resolveChannelPreference(
  channel: NotificationChannel,
  stored: ChannelPreferenceValue | null,
): EffectiveChannelPreference {
  if (channel === NotificationChannel.IN_APP) {
    return { channel, enabled: true, digestFrequency: DigestFrequency.IMMEDIATE, configurable: false, source: PreferenceSource.POLICY };
  }
  if (stored) {
    return { channel, enabled: stored.enabled, digestFrequency: stored.digestFrequency, configurable: true, source: PreferenceSource.STORED };
  }
  return { channel, ...DEFAULT_CHANNEL_PREFERENCE, configurable: true, source: PreferenceSource.DEFAULT };
}
