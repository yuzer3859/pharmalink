import { Inject, Injectable } from '@nestjs/common';
import {
  DeliveryChannelHealthSnapshot,
  INotificationDeliveryChannelHealthPort,
  NOTIFICATION_DELIVERY_CHANNEL_HEALTH_PORT,
} from '../../../notifications/application/ports/inbound/notification-delivery-channel-health.port';

/**
 * `GET /admin/notifications/delivery/channels` (module-16 Work 24): per-channel backlog, stale
 * leases and provider readiness through Module 13's `NOTIFICATION_DELIVERY_CHANNEL_HEALTH_PORT`.
 * Read-only; not audited.
 */
@Injectable()
export class GetDeliveryChannelHealthQuery {
  constructor(@Inject(NOTIFICATION_DELIVERY_CHANNEL_HEALTH_PORT) private readonly deliveries: INotificationDeliveryChannelHealthPort) {}

  execute(): Promise<DeliveryChannelHealthSnapshot> {
    return this.deliveries.channelHealth();
  }
}
