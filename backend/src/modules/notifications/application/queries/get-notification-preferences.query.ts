import { Inject, Injectable } from '@nestjs/common';
import { NotificationErrors } from '../../domain/errors';
import { NotificationCategory, NotificationChannel } from '../../domain/enums';
import {
  CONFIGURABLE_CATEGORIES,
  EffectiveChannelPreference,
  isConfigurableCategory,
  REPORTED_CHANNELS,
  resolveChannelPreference,
} from '../../domain/preferences';
import {
  INotificationPreferenceRepository,
  NOTIFICATION_PREFERENCE_REPOSITORY,
  StoredChannelPreference,
} from '../../domain/repositories/notification-preference.repository';

/** One category's effective preferences, every reported channel present. */
export interface CategoryPreferences {
  category: NotificationCategory;
  channels: EffectiveChannelPreference[];
}

function toCategory(category: NotificationCategory, stored: StoredChannelPreference[]): CategoryPreferences {
  return {
    category,
    channels: REPORTED_CHANNELS.map((channel) =>
      resolveChannelPreference(channel, stored.find((s) => s.category === category && s.channel === channel) ?? null),
    ),
  };
}

/**
 * The user's effective notification preferences (module-13 Work 11): stored rows merged over the
 * defaults by `resolveChannelPreference`. Reads write nothing — an absent row stays absent.
 */
@Injectable()
export class GetNotificationPreferencesQuery {
  constructor(
    @Inject(NOTIFICATION_PREFERENCE_REPOSITORY) private readonly preferences: INotificationPreferenceRepository,
  ) {}

  async all(userId: string): Promise<CategoryPreferences[]> {
    const stored = await this.preferences.listForUser(userId);
    return CONFIGURABLE_CATEGORIES.map((category) => toCategory(category, stored));
  }

  async forCategory(userId: string, category: NotificationCategory): Promise<CategoryPreferences> {
    if (!isConfigurableCategory(category)) throw NotificationErrors.preferenceNotConfigurable({ category });
    return toCategory(category, await this.preferences.listForUser(userId, category));
  }

  /**
   * The effective preference for one (category, channel) — the lookup a delivery channel makes
   * before sending (Work 12 onward). The same precedence the API reports.
   */
  async forChannel(
    userId: string,
    category: NotificationCategory,
    channel: NotificationChannel,
  ): Promise<EffectiveChannelPreference> {
    if (channel === NotificationChannel.IN_APP) return resolveChannelPreference(channel, null);
    const stored = await this.preferences.listForUser(userId, category);
    return resolveChannelPreference(channel, stored.find((s) => s.channel === channel) ?? null);
  }
}
