import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { DomainEvent } from '../../../../shared/events/domain-event';
import { EVENT_BUS, IEventBus } from '../../../../shared/events/event-bus.service';
import {
  AccountStatusChangedPayload,
  IdentityEventType,
  LicenseExpiredPayload,
  ProviderDecisionPayload,
} from '../../../identity/domain/events';
import { OrderPlacedPayload, OrdersEventType } from '../../../orders/domain/events';
import { RecordNotificationCommand } from '../../application/commands/record-notification.command';
import { EventNotifications, NotificationIntent } from '../../application/support/event-notifications';

/**
 * Module 13's consumers on the shared event bus (module-13 Work 01). Six events, each naming its
 * recipient in its own payload, so no recipient is looked up anywhere.
 *
 * At-least-once, as the bus is (ADR-010): the outbox relay can deliver an event twice, and
 * `RecordNotificationCommand` writes at most one row per event per recipient. A handler that
 * throws is caught and logged by `EventBusService`, and the relay still marks the event
 * published — so a failure here is not retried. Accepted for this work; see the module doc.
 */
@Injectable()
export class NotificationEventsHandler implements OnModuleInit {
  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly record: RecordNotificationCommand,
  ) {}

  onModuleInit(): void {
    this.on<ProviderDecisionPayload>(IdentityEventType.ProviderApproved, EventNotifications.providerApproved);
    this.on<ProviderDecisionPayload>(IdentityEventType.ProviderRejected, EventNotifications.providerRejected);
    this.on<LicenseExpiredPayload>(IdentityEventType.LicenseExpired, EventNotifications.licenseExpired);
    this.on<AccountStatusChangedPayload>(IdentityEventType.AccountSuspended, EventNotifications.accountSuspended);
    this.on<AccountStatusChangedPayload>(IdentityEventType.AccountReactivated, EventNotifications.accountReactivated);
    this.on<OrderPlacedPayload>(OrdersEventType.OrderPlaced, EventNotifications.orderPlaced);
  }

  private on<T>(eventType: string, toIntent: (payload: T) => NotificationIntent): void {
    this.bus.subscribe<T>(eventType, async (event: DomainEvent<T>) => {
      await this.record.execute({ eventId: event.id, eventType: event.type, intent: toIntent(event.payload) });
    });
  }
}
