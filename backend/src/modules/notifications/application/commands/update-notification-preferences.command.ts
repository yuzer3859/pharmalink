import { Inject, Injectable } from '@nestjs/common';
import { NotificationErrors } from '../../domain/errors';
import { NotificationCategory } from '../../domain/enums';
import { isConfigurableCategory, isConfigurableChannel } from '../../domain/preferences';
import {
  ChannelPreferenceChange,
  INotificationPreferenceRepository,
  NOTIFICATION_PREFERENCE_REPOSITORY,
} from '../../domain/repositories/notification-preference.repository';
import { CategoryPreferences, GetNotificationPreferencesQuery } from '../queries/get-notification-preferences.query';

export interface UpdateNotificationPreferencesInput {
  /** Always the authenticated principal — never taken from a request body. */
  userId: string;
  category: NotificationCategory;
  channels: ChannelPreferenceChange[];
}

/**
 * `PUT /notification-preferences/:category` (module-13 Work 11). Creates or updates the listed
 * channels' rows and leaves unlisted channels as they were, so repeating a request changes nothing.
 * Not audited: a user's own preference toggle has no audit convention in the repository (Module
 * 01's `preferredLanguage` update is not audited either), and it publishes no event.
 */
@Injectable()
export class UpdateNotificationPreferencesCommand {
  constructor(
    @Inject(NOTIFICATION_PREFERENCE_REPOSITORY) private readonly preferences: INotificationPreferenceRepository,
    private readonly read: GetNotificationPreferencesQuery,
  ) {}

  async execute(input: UpdateNotificationPreferencesInput): Promise<CategoryPreferences> {
    if (!isConfigurableCategory(input.category)) {
      throw NotificationErrors.preferenceNotConfigurable({ category: input.category });
    }
    const seen = new Set<string>();
    for (const change of input.channels) {
      if (!isConfigurableChannel(change.channel) || seen.has(change.channel)) {
        throw NotificationErrors.preferenceNotConfigurable({ category: input.category, channel: change.channel });
      }
      seen.add(change.channel);
    }
    if (input.channels.length > 0) await this.preferences.upsert(input.userId, input.category, input.channels);
    return this.read.forCategory(input.userId, input.category);
  }
}
