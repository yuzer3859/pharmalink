import { Inject, Injectable } from '@nestjs/common';
import {
  DeliveryQueueHealth,
  INotificationDeliveryHealthPort,
  NOTIFICATION_DELIVERY_HEALTH_PORT,
} from '../../../notifications/application/ports/inbound/notification-delivery-health.port';

/**
 * `GET /admin/notifications/delivery/health` (module-16 Work 22): backlog and stale-lease
 * aggregates through Module 13's `NOTIFICATION_DELIVERY_HEALTH_PORT`. Read-only; not audited.
 */
@Injectable()
export class GetDeliveryQueueHealthQuery {
  constructor(@Inject(NOTIFICATION_DELIVERY_HEALTH_PORT) private readonly deliveries: INotificationDeliveryHealthPort) {}

  execute(): Promise<DeliveryQueueHealth> {
    return this.deliveries.health();
  }
}
