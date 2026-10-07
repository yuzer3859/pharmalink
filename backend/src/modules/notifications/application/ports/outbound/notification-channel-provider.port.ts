import { NotificationCategory, NotificationChannel } from '../../../domain/enums';

export const NOTIFICATION_CHANNEL_PROVIDER_REGISTRY = Symbol('NOTIFICATION_CHANNEL_PROVIDER_REGISTRY');

/**
 * What a channel provider is given (module-13 Work 12). Deliberately small and channel-neutral:
 * the rendered text, the notification it belongs to, and an opaque recipient reference. No phone
 * number, e-mail address or device token — resolving those needs contracts that do not exist yet
 * (a Module 01 contact read port; device-token registration) and belongs to the work that adds
 * the real provider. Frozen before it is handed over, so a provider cannot alter it.
 */
export interface ChannelDeliveryRequest {
  readonly notificationId: string;
  readonly channel: NotificationChannel;
  readonly category: NotificationCategory;
  readonly recipient: { readonly userId: string };
  readonly title: string;
  readonly body: string;
}

/** What a provider reports. It carries no recipient: the recipient is never the provider's to set. */
export type ChannelDeliveryResult =
  | { outcome: 'SENT'; providerMessageId?: string }
  | { outcome: 'DELIVERED'; providerMessageId?: string }
  | { outcome: 'FAILED'; errorCode?: string }
  | { outcome: 'NOT_CONFIGURED' };

/** One external channel's provider. Implementations hold their own credentials; none cross this port. */
export interface INotificationChannelProvider {
  /** A short, non-secret name stored on the attempt, e.g. `fcm`. */
  readonly name: string;
  readonly channel: NotificationChannel;
  deliver(request: ChannelDeliveryRequest): Promise<ChannelDeliveryResult>;
}

/** Which provider, if any, carries each channel. */
export interface INotificationChannelProviderRegistry {
  providerFor(channel: NotificationChannel): INotificationChannelProvider | null;
}
