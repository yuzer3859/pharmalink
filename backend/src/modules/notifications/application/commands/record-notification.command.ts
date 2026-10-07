import { Inject, Injectable } from '@nestjs/common';
import {
  IDENTITY_LANGUAGE_READ_PORT,
  IIdentityLanguageReadPort,
} from '../../../identity/application/ports/inbound/identity-language-read.port';
import { channelsToEnqueue } from '../../domain/delivery-policy';
import { NotificationChannel, NotificationLanguage, NotificationStatus } from '../../domain/enums';
import { isConfigurableCategory } from '../../domain/preferences';
import {
  INotificationPreferenceRepository,
  NOTIFICATION_PREFERENCE_REPOSITORY,
} from '../../domain/repositories/notification-preference.repository';
import { INotificationRepository, NOTIFICATION_REPOSITORY } from '../../domain/repositories/notification.repository';
import { NOTIFICATION_TEMPLATES, renderNotification } from '../../domain/templates';
import { dedupeKeyFor, NotificationIntent } from '../support/event-notifications';

export interface RecordNotificationInput {
  /** The source event's id — with the recipient, the idempotency key. */
  eventId: string;
  eventType: string;
  intent: NotificationIntent;
}

export interface RecordNotificationResult {
  created: boolean;
  language: NotificationLanguage;
}

/**
 * Turns one event's intent into one in-app notification: the recipient's language from Module
 * 01, the text from the code-owned catalogue, and one idempotent insert.
 *
 * The insert is a single `INSERT … ON CONFLICT DO NOTHING` on the unique `dedupeKey`, so a
 * redelivered event, a re-run handler or two concurrent deliveries all leave exactly one row.
 *
 * Work 13: the same write queues one delivery job per external channel the recipient's preference
 * (Work 11) allows at this moment — none for `IN_APP`, none for a disabled channel — in one
 * transaction with the notification. A job is queued even when no provider exists for its
 * channel; it waits. A duplicate notification queues nothing.
 */
@Injectable()
export class RecordNotificationCommand {
  constructor(
    @Inject(NOTIFICATION_REPOSITORY) private readonly notifications: INotificationRepository,
    @Inject(IDENTITY_LANGUAGE_READ_PORT) private readonly languages: IIdentityLanguageReadPort,
    @Inject(NOTIFICATION_PREFERENCE_REPOSITORY) private readonly preferences: INotificationPreferenceRepository,
  ) {}

  async execute(input: RecordNotificationInput): Promise<RecordNotificationResult> {
    const { intent } = input;
    const preferred = await this.languages.preferredLanguageOf(intent.recipientUserId);
    const rendered = renderNotification(intent.templateCode, preferred, intent.data);
    const category = NOTIFICATION_TEMPLATES[intent.templateCode].category;
    const deliveryChannels = isConfigurableCategory(category)
      ? channelsToEnqueue(category, await this.preferences.listForUser(intent.recipientUserId, category))
      : [];

    const created = await this.notifications.insertIfAbsent(
      {
        recipientUserId: intent.recipientUserId,
        category,
        channel: NotificationChannel.IN_APP,
        templateCode: intent.templateCode,
        eventType: input.eventType,
        dedupeKey: dedupeKeyFor(input.eventId, intent.recipientUserId),
        data: intent.data,
        title: rendered.title,
        body: rendered.body,
        status: NotificationStatus.SENT,
      },
      deliveryChannels,
    );
    return { created, language: rendered.language };
  }
}
