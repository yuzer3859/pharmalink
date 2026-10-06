import { DigestFrequency, NotificationCategory, NotificationChannel } from '../enums';

export const NOTIFICATION_PREFERENCE_REPOSITORY = Symbol('NOTIFICATION_PREFERENCE_REPOSITORY');

/** One stored `channel_preferences` row, without its id or owner. */
export interface StoredChannelPreference {
  category: NotificationCategory;
  channel: NotificationChannel;
  enabled: boolean;
  digestFrequency: DigestFrequency;
}

/** A change to one channel. An absent `digestFrequency` keeps the stored one (or the default). */
export interface ChannelPreferenceChange {
  channel: NotificationChannel;
  enabled: boolean;
  digestFrequency?: DigestFrequency;
}

/**
 * Persistence port for notification preferences (module-13 Work 11) over `channel_preferences`.
 * Every method takes the owner; none reaches a row by id, so an ownership check cannot be skipped.
 */
export interface INotificationPreferenceRepository {
  /** The user's stored rows, optionally for one category. Absent rows are simply not returned. */
  listForUser(userId: string, category?: NotificationCategory): Promise<StoredChannelPreference[]>;
  /**
   * Creates or updates one row per change on the (userId, category, channel) unique key, all in
   * one transaction. Concurrent first writes do not fail: each is an `INSERT … ON CONFLICT DO
   * UPDATE`.
   */
  upsert(userId: string, category: NotificationCategory, changes: ChannelPreferenceChange[]): Promise<void>;
}
