import { Inject, Injectable } from '@nestjs/common';
import { AppLogger } from '../../../../shared/logging/app-logger.service';
import {
  DeliveryErrorCode,
  evaluateChannel,
  externalChannelsFor,
  PROVIDER_ERROR_CODE,
  SETTLED_ATTEMPT_STATUSES,
} from '../../domain/delivery-policy';
import { NotificationChannel, NotificationStatus } from '../../domain/enums';
import { isConfigurableCategory } from '../../domain/preferences';
import {
  DeliverableNotification,
  INotificationDeliveryRepository,
  NewDeliveryAttempt,
  NOTIFICATION_DELIVERY_REPOSITORY,
} from '../../domain/repositories/notification-delivery.repository';
import {
  INotificationPreferenceRepository,
  NOTIFICATION_PREFERENCE_REPOSITORY,
} from '../../domain/repositories/notification-preference.repository';
import {
  ChannelDeliveryRequest,
  ChannelDeliveryResult,
  INotificationChannelProviderRegistry,
  NOTIFICATION_CHANNEL_PROVIDER_REGISTRY,
} from '../ports/outbound/notification-channel-provider.port';

/** What happened on one channel during one delivery call. */
export enum ChannelOutcome {
  /** `IN_APP` — the notification row itself; no provider, no attempt. */
  IN_APP_RECORDED = 'IN_APP_RECORDED',
  /** A previous attempt settled the channel; nothing recorded this time. */
  ALREADY_SETTLED = 'ALREADY_SETTLED',
  /** The preference disabled it: a `SUPPRESSED` attempt, no provider called. */
  SUPPRESSED = 'SUPPRESSED',
  /** No provider bound (or the provider says it is unconfigured): a `FAILED` attempt. */
  NOT_CONFIGURED = 'NOT_CONFIGURED',
  /** The provider accepted it: a `SENT` attempt. */
  SENT = 'SENT',
  /** The provider failed, threw or answered nonsense: a `FAILED` attempt. */
  FAILED = 'FAILED',
}

export type DeliveryResult =
  | { status: 'NOT_FOUND' }
  | { status: 'UNSUPPORTED_SOURCE' }
  | { status: 'UNSUPPORTED_CATEGORY' }
  | { status: 'PROCESSED'; channels: Array<{ channel: NotificationChannel; outcome: ChannelOutcome; attemptNumber?: number }> };

const MAX_PROVIDER_NAME = 64;
const MAX_PROVIDER_MESSAGE_ID = 128;

/**
 * Provider-neutral delivery of one stored notification to the external channels (module-13 Work
 * 12). Internal infrastructure: no route reaches it, nothing calls it automatically yet, and it
 * never changes the notification row — the in-app copy stays exactly as Works 01–10 wrote it.
 *
 *     notification (IN_APP row) ─→ category supported?
 *        └─ for PUSH, SMS, EMAIL:
 *             settled already (SENT | DELIVERED | SUPPRESSED)? → nothing
 *             preference (Work 11, `channel_preferences`) disables it? → SUPPRESSED attempt
 *             no provider bound?                                    → FAILED, CHANNEL_NOT_CONFIGURED
 *             provider.deliver(frozen request)                      → SENT | FAILED attempt
 *
 * `delivery_attempts` is append-only: a `FAILED` channel is attempted again on the next call, as
 * attempt n + 1. Only non-secret, pipeline-controlled values are stored: the provider's name and
 * message id (truncated), and an error *code* — never a provider's free-text error or exception
 * message, which could carry credentials or contact data. Not audited (no convention covers
 * delivery), and no event is published.
 */
@Injectable()
export class NotificationDeliveryService {
  constructor(
    @Inject(NOTIFICATION_DELIVERY_REPOSITORY) private readonly deliveries: INotificationDeliveryRepository,
    @Inject(NOTIFICATION_PREFERENCE_REPOSITORY) private readonly preferences: INotificationPreferenceRepository,
    @Inject(NOTIFICATION_CHANNEL_PROVIDER_REGISTRY) private readonly providers: INotificationChannelProviderRegistry,
    private readonly logger: AppLogger,
  ) {
    this.logger.setContext(NotificationDeliveryService.name);
  }

  async deliver(notificationId: string): Promise<DeliveryResult> {
    const notification = await this.deliveries.findDeliverable(notificationId);
    if (!notification) return { status: 'NOT_FOUND' };
    if (notification.channel !== NotificationChannel.IN_APP) return { status: 'UNSUPPORTED_SOURCE' };
    if (!isConfigurableCategory(notification.category)) return { status: 'UNSUPPORTED_CATEGORY' };

    const stored = await this.preferences.listForUser(notification.recipientUserId, notification.category);
    const attempts = await this.deliveries.listAttempts(notification.id);
    const channels: Extract<DeliveryResult, { status: 'PROCESSED' }>['channels'] = [
      { channel: NotificationChannel.IN_APP, outcome: ChannelOutcome.IN_APP_RECORDED },
    ];

    for (const channel of externalChannelsFor(notification.category)) {
      const latest = attempts
        .filter((a) => a.channel === channel)
        .reduce<(typeof attempts)[number] | null>((top, a) => (!top || a.attemptNumber > top.attemptNumber ? a : top), null);
      if (latest && SETTLED_ATTEMPT_STATUSES.has(latest.status)) {
        channels.push({ channel, outcome: ChannelOutcome.ALREADY_SETTLED });
        continue;
      }
      const attemptNumber = (latest?.attemptNumber ?? 0) + 1;
      const preference = stored.find((s) => s.channel === channel) ?? null;
      const decision = evaluateChannel(notification.category, channel, preference);

      const [outcome, attempt] = decision.allowed
        ? await this.attempt(notification, channel, attemptNumber)
        : [
            ChannelOutcome.SUPPRESSED,
            this.row(notification, channel, attemptNumber, NotificationStatus.SUPPRESSED, { errorCode: DeliveryErrorCode.PREFERENCE_DISABLED }),
          ];
      await this.deliveries.recordAttempt(attempt);
      channels.push({ channel, outcome, attemptNumber });
    }
    return { status: 'PROCESSED', channels };
  }

  private async attempt(
    n: DeliverableNotification,
    channel: NotificationChannel,
    attemptNumber: number,
  ): Promise<[ChannelOutcome, NewDeliveryAttempt]> {
    const provider = this.providers.providerFor(channel);
    const notConfigured = (name: string | null): [ChannelOutcome, NewDeliveryAttempt] => [
      ChannelOutcome.NOT_CONFIGURED,
      this.row(n, channel, attemptNumber, NotificationStatus.FAILED, { provider: name, errorCode: DeliveryErrorCode.CHANNEL_NOT_CONFIGURED }),
    ];
    if (!provider) return notConfigured(null);
    const name = String(provider.name).slice(0, MAX_PROVIDER_NAME);

    // Built from the notification, then frozen: whatever the provider does, the recipient and
    // text recorded below are the notification's own.
    const request: ChannelDeliveryRequest = Object.freeze({
      notificationId: n.id,
      channel,
      category: n.category,
      recipient: Object.freeze({ userId: n.recipientUserId }),
      title: n.title,
      body: n.body,
    });

    let result: ChannelDeliveryResult;
    try {
      result = await provider.deliver(request);
    } catch {
      // The exception's message is not stored or logged: it may carry a credential or an address.
      this.logger.warn(`provider ${name} threw delivering notification ${n.id} on ${channel}`);
      return [ChannelOutcome.FAILED, this.row(n, channel, attemptNumber, NotificationStatus.FAILED, { provider: name, errorCode: DeliveryErrorCode.PROVIDER_ERROR })];
    }

    switch (result?.outcome) {
      case 'SENT':
        return [
          ChannelOutcome.SENT,
          this.row(n, channel, attemptNumber, NotificationStatus.SENT, {
            provider: name,
            providerMessageId: typeof result.providerMessageId === 'string' ? result.providerMessageId.slice(0, MAX_PROVIDER_MESSAGE_ID) : null,
          }),
        ];
      case 'FAILED': {
        const code = typeof result.errorCode === 'string' && PROVIDER_ERROR_CODE.test(result.errorCode) ? result.errorCode : DeliveryErrorCode.PROVIDER_ERROR;
        return [ChannelOutcome.FAILED, this.row(n, channel, attemptNumber, NotificationStatus.FAILED, { provider: name, errorCode: code })];
      }
      case 'NOT_CONFIGURED':
        return notConfigured(name);
      default:
        return [
          ChannelOutcome.FAILED,
          this.row(n, channel, attemptNumber, NotificationStatus.FAILED, { provider: name, errorCode: DeliveryErrorCode.PROVIDER_INVALID_RESULT }),
        ];
    }
  }

  private row(
    n: DeliverableNotification,
    channel: NotificationChannel,
    attemptNumber: number,
    status: NotificationStatus,
    extra: { provider?: string | null; providerMessageId?: string | null; errorCode?: string | null },
  ): NewDeliveryAttempt {
    return {
      notificationId: n.id,
      attemptNumber,
      channel,
      provider: extra.provider ?? null,
      providerMessageId: extra.providerMessageId ?? null,
      status,
      errorCode: extra.errorCode ?? null,
      errorDetail: null,
    };
  }
}
