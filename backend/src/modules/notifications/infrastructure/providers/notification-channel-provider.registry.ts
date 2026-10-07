import { NotificationChannel } from '../../domain/enums';
import {
  INotificationChannelProvider,
  INotificationChannelProviderRegistry,
} from '../../application/ports/outbound/notification-channel-provider.port';

/**
 * A fixed set of channel providers, at most one per channel (module-13 Work 12). The module binds
 * it **empty**: no PUSH, SMS or EMAIL provider exists yet, so delivery jobs wait `PENDING` and
 * nothing is sent. A real provider is added here when its work lands; waiting jobs then go out.
 */
export class StaticNotificationChannelProviderRegistry implements INotificationChannelProviderRegistry {
  private readonly byChannel = new Map<NotificationChannel, INotificationChannelProvider>();

  constructor(providers: INotificationChannelProvider[]) {
    for (const p of providers) {
      if (p.channel === NotificationChannel.IN_APP) throw new Error('IN_APP is not delivered through a provider.');
      if (this.byChannel.has(p.channel)) throw new Error(`Two providers bound for ${p.channel}.`);
      this.byChannel.set(p.channel, p);
    }
  }

  providerFor(channel: NotificationChannel): INotificationChannelProvider | null {
    return this.byChannel.get(channel) ?? null;
  }
}
