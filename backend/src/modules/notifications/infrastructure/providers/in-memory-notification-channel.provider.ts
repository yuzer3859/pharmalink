import { NotificationChannel } from '../../domain/enums';
import {
  ChannelDeliveryRequest,
  ChannelDeliveryResult,
  INotificationChannelProvider,
} from '../../application/ports/outbound/notification-channel-provider.port';

export type InMemoryProviderBehaviour = 'SENT' | 'FAILED' | 'NOT_CONFIGURED' | 'THROW';

/**
 * **NON-PRODUCTION.** A deterministic, in-process stand-in for a PUSH / SMS / EMAIL provider
 * (module-13 Work 12). It performs no network I/O and sends nothing to anyone: it keeps the
 * requests it was handed in memory and answers with the behaviour it was constructed with.
 *
 * It is not bound by `NotificationsModule` — production has no provider for any external channel —
 * and exists for tests to bind through `NOTIFICATION_CHANNEL_PROVIDER_REGISTRY`. Its message ids
 * are derived from the request, so a test can predict them.
 */
export class InMemoryNotificationChannelProvider implements INotificationChannelProvider {
  readonly name: string;
  readonly delivered: ChannelDeliveryRequest[] = [];

  constructor(
    readonly channel: NotificationChannel,
    private readonly behaviour: InMemoryProviderBehaviour = 'SENT',
    private readonly failureCode = 'IN_MEMORY_FAILURE',
  ) {
    this.name = `in-memory-${channel.toLowerCase()}`;
  }

  async deliver(request: ChannelDeliveryRequest): Promise<ChannelDeliveryResult> {
    this.delivered.push(request);
    switch (this.behaviour) {
      case 'SENT':
        return { outcome: 'SENT', providerMessageId: `in-memory:${request.channel}:${request.notificationId}` };
      case 'FAILED':
        return { outcome: 'FAILED', errorCode: this.failureCode };
      case 'NOT_CONFIGURED':
        return { outcome: 'NOT_CONFIGURED' };
      case 'THROW':
        throw new Error('in-memory provider failure');
    }
  }
}
