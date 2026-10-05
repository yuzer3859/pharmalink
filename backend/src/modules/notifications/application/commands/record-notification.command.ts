import { Inject, Injectable } from '@nestjs/common';
import {
  IDENTITY_LANGUAGE_READ_PORT,
  IIdentityLanguageReadPort,
} from '../../../identity/application/ports/inbound/identity-language-read.port';
import { NotificationChannel, NotificationLanguage, NotificationStatus } from '../../domain/enums';
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
 * The insert is the whole write — a single `INSERT … ON CONFLICT DO NOTHING` on the unique
 * `dedupeKey` — so it is atomic without a surrounding transaction, and a redelivered event, a
 * re-run handler or two concurrent deliveries all leave exactly one row.
 */
@Injectable()
export class RecordNotificationCommand {
  constructor(
    @Inject(NOTIFICATION_REPOSITORY) private readonly notifications: INotificationRepository,
    @Inject(IDENTITY_LANGUAGE_READ_PORT) private readonly languages: IIdentityLanguageReadPort,
  ) {}

  async execute(input: RecordNotificationInput): Promise<RecordNotificationResult> {
    const { intent } = input;
    const preferred = await this.languages.preferredLanguageOf(intent.recipientUserId);
    const rendered = renderNotification(intent.templateCode, preferred, intent.data);

    const created = await this.notifications.insertIfAbsent({
      recipientUserId: intent.recipientUserId,
      category: NOTIFICATION_TEMPLATES[intent.templateCode].category,
      channel: NotificationChannel.IN_APP,
      templateCode: intent.templateCode,
      eventType: input.eventType,
      dedupeKey: dedupeKeyFor(input.eventId, intent.recipientUserId),
      data: intent.data,
      title: rendered.title,
      body: rendered.body,
      status: NotificationStatus.SENT,
    });
    return { created, language: rendered.language };
  }
}
