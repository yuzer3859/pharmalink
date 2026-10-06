import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { DomainEvent } from '../../../../shared/events/domain-event';
import { EVENT_BUS, IEventBus } from '../../../../shared/events/event-bus.service';
import {
  AccountStatusChangedPayload,
  IdentityEventType,
  LicenseExpiredPayload,
  ProviderDecisionPayload,
} from '../../../identity/domain/events';
import {
  OrderAcceptedPayload,
  OrderCancelledPayload,
  OrderPlacedPayload,
  OrderReadyPayload,
  OrdersEventType,
} from '../../../orders/domain/events';
import {
  PaymentCapturedPayload,
  PaymentEventType,
  PaymentFailedPayload,
  PaymentRefundedPayload,
  WalletEventType,
  WalletMovementPayload,
} from '../../../payment/domain/events';
import type { PaymentRecipientView } from '../../../payment/application/ports/inbound/payment-recipient-read.port';
import {
  CodCorrectionRecordedPayload,
  CodReconciledPayload,
  CodRemittedPayload,
  DeliveryEventType,
  DeliveryFailedPayload,
  DeliveryStatusPayload,
  EarningAccruedPayload,
  JobAssignedPayload,
  JobOfferedPayload,
} from '../../../delivery/domain/events';
import { RecordDriverNotificationCommand } from '../../application/commands/record-driver-notification.command';
import {
  MatchFailedPayload,
  OrderMatchedPayload,
  PrescriptionApprovedPayload,
  PrescriptionMatchingEventType,
  PrescriptionRejectedPayload,
  RematchTriggeredPayload,
} from '../../../prescription-matching/domain/events';
import {
  PrescriptionSubject,
  RecordPrescriptionNotificationCommand,
} from '../../application/commands/record-prescription-notification.command';
import {
  PharmacyActivatedPayload,
  PharmacyInventoryEventType,
  PharmacySuspendedPayload,
} from '../../../pharmacy-inventory/domain/events';
import { RecordPharmacyNotificationCommand } from '../../application/commands/record-pharmacy-notification.command';
import { RecordOrderNotificationCommand } from '../../application/commands/record-order-notification.command';
import { RecordPaymentNotificationCommand } from '../../application/commands/record-payment-notification.command';
import { RecordNotificationCommand } from '../../application/commands/record-notification.command';
import {
  EventNotifications,
  NotificationIntent,
  OrderLifecycleNotifications,
  DeliveryNotifications,
  DriverNotifications,
  PaymentNotifications,
  PharmacyNotifications,
  PrescriptionNotifications,
} from '../../application/support/event-notifications';

/**
 * Module 13's consumers on the shared event bus. Work 01: six events, each naming its recipient
 * in its own payload. Work 02: `order.accepted`, `order.ready` and `order.cancelled`, which name
 * the order only — their recipient is the order's customer, asked of Module 06 through
 * `RecordOrderNotificationCommand`. Work 03: `payment.captured` and `payment.failed` (which name the
 * order, so the same path) and `payment.refunded` (which names the payment only — its customer
 * is asked of Module 07 through `RecordPaymentNotificationCommand`). Work 04: Module 08's
 * `delivery.order.picked_up`, `.en_route`, `.delivered` and `delivery.failed`, which name the
 * order — the order path again, alongside (never instead of) Module 08's own consumers. Work 05:
 * Module 08's driver-addressed events (offer, earning, COD remitted/reconciled/corrected), whose
 * `driverId` is a driver profile — its person is asked of Module 08 through
 * `RecordDriverNotificationCommand`. Work 06: Module 05's `prescription.approved`, `.rejected`
 * and `matching.match_failed`, whose customer is asked of Module 05 through
 * `RecordPrescriptionNotificationCommand`. Work 07: Module 04's `pharmacy.pharmacy.activated` and
 * `.suspended`, told to the pharmacy's organization owner through
 * `RecordPharmacyNotificationCommand`. Work 08: Module 07's `wallet.credited` and
 * `wallet.debited`, which name their user — the direct path, like Work 01's. Work 09:
 * `delivery.job.assigned`, through the Work 05 driver path — a separate notification from the
 * offer, because it is a separate event. Work 10: Module 05's `matching.order_matched` and
 * `matching.rematch_triggered`, to the match request's customer on Work 06's path.
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
    private readonly recordForOrder: RecordOrderNotificationCommand,
    private readonly recordForPayment: RecordPaymentNotificationCommand,
    private readonly recordForDriver: RecordDriverNotificationCommand,
    private readonly recordForPrescription: RecordPrescriptionNotificationCommand,
    private readonly recordForPharmacy: RecordPharmacyNotificationCommand,
  ) {}

  onModuleInit(): void {
    this.on<ProviderDecisionPayload>(IdentityEventType.ProviderApproved, EventNotifications.providerApproved);
    this.on<ProviderDecisionPayload>(IdentityEventType.ProviderRejected, EventNotifications.providerRejected);
    this.on<LicenseExpiredPayload>(IdentityEventType.LicenseExpired, EventNotifications.licenseExpired);
    this.on<AccountStatusChangedPayload>(IdentityEventType.AccountSuspended, EventNotifications.accountSuspended);
    this.on<AccountStatusChangedPayload>(IdentityEventType.AccountReactivated, EventNotifications.accountReactivated);
    this.on<OrderPlacedPayload>(OrdersEventType.OrderPlaced, EventNotifications.orderPlaced);
    this.on<WalletMovementPayload>(WalletEventType.WalletCredited, EventNotifications.walletCredited);
    this.on<WalletMovementPayload>(WalletEventType.WalletDebited, EventNotifications.walletDebited);

    this.onOrder<OrderAcceptedPayload>(OrdersEventType.OrderAccepted, OrderLifecycleNotifications.orderAccepted);
    this.onOrder<OrderReadyPayload>(OrdersEventType.OrderReady, OrderLifecycleNotifications.orderReady);
    this.onOrder<OrderCancelledPayload>(OrdersEventType.OrderCancelled, OrderLifecycleNotifications.orderCancelled);

    this.onOrder<PaymentCapturedPayload>(PaymentEventType.PaymentCaptured, PaymentNotifications.paymentCaptured);
    this.onOrder<PaymentFailedPayload>(PaymentEventType.PaymentFailed, PaymentNotifications.paymentFailed);
    this.onPayment<PaymentRefundedPayload>(PaymentEventType.PaymentRefunded, PaymentNotifications.paymentRefunded);

    this.onOrder<DeliveryStatusPayload>(DeliveryEventType.OrderPickedUp, DeliveryNotifications.orderPickedUp);
    this.onOrder<DeliveryStatusPayload>(DeliveryEventType.EnRoute, DeliveryNotifications.orderEnRoute);
    this.onOrder<DeliveryStatusPayload>(DeliveryEventType.OrderDelivered, DeliveryNotifications.orderDelivered);
    this.onOrder<DeliveryFailedPayload>(DeliveryEventType.DeliveryFailed, DeliveryNotifications.deliveryFailed);

    this.onDriver<JobOfferedPayload>(DeliveryEventType.JobOffered, DriverNotifications.jobOffered);
    this.onDriver<JobAssignedPayload>(DeliveryEventType.JobAssigned, DriverNotifications.jobAssigned);
    this.onDriver<EarningAccruedPayload>(DeliveryEventType.EarningAccrued, DriverNotifications.earningAccrued);
    this.onDriver<CodRemittedPayload>(DeliveryEventType.CodRemitted, DriverNotifications.codRemitted);
    this.onDriver<CodReconciledPayload>(DeliveryEventType.CodReconciled, DriverNotifications.codReconciled);
    this.onDriver<CodCorrectionRecordedPayload>(
      DeliveryEventType.CodCorrectionRecorded,
      DriverNotifications.codCorrectionRecorded,
    );

    this.onPrescription<PrescriptionApprovedPayload>(
      PrescriptionMatchingEventType.PrescriptionApproved,
      (p) => ({ kind: 'prescription', id: p.prescriptionId }),
      PrescriptionNotifications.prescriptionApproved,
    );
    this.onPrescription<PrescriptionRejectedPayload>(
      PrescriptionMatchingEventType.PrescriptionRejected,
      (p) => ({ kind: 'prescription', id: p.prescriptionId }),
      PrescriptionNotifications.prescriptionRejected,
    );
    this.onPrescription<MatchFailedPayload>(
      PrescriptionMatchingEventType.MatchFailed,
      (p) => ({ kind: 'matchRequest', id: p.matchRequestId }),
      PrescriptionNotifications.matchFailed,
    );
    this.onPrescription<OrderMatchedPayload>(
      PrescriptionMatchingEventType.OrderMatched,
      (p) => ({ kind: 'matchRequest', id: p.matchRequestId }),
      PrescriptionNotifications.orderMatched,
    );
    this.onPrescription<RematchTriggeredPayload>(
      PrescriptionMatchingEventType.RematchTriggered,
      (p) => ({ kind: 'matchRequest', id: p.matchRequestId }),
      PrescriptionNotifications.rematchTriggered,
    );

    this.onPharmacy<PharmacyActivatedPayload>(PharmacyInventoryEventType.PharmacyActivated, PharmacyNotifications.pharmacyActivated);
    this.onPharmacy<PharmacySuspendedPayload>(PharmacyInventoryEventType.PharmacySuspended, PharmacyNotifications.pharmacySuspended);
  }

  private on<T>(eventType: string, toIntent: (payload: T) => NotificationIntent): void {
    this.bus.subscribe<T>(eventType, async (event: DomainEvent<T>) => {
      await this.record.execute({ eventId: event.id, eventType: event.type, intent: toIntent(event.payload) });
    });
  }

  private onOrder<T extends { orderId: string }>(
    eventType: string,
    toIntent: (payload: T, customerUserId: string) => NotificationIntent,
  ): void {
    this.bus.subscribe<T>(eventType, async (event: DomainEvent<T>) => {
      await this.recordForOrder.execute({ eventId: event.id, eventType: event.type, payload: event.payload, toIntent });
    });
  }

  private onPayment<T extends { paymentId: string }>(
    eventType: string,
    toIntent: (payload: T, payment: PaymentRecipientView) => NotificationIntent,
  ): void {
    this.bus.subscribe<T>(eventType, async (event: DomainEvent<T>) => {
      await this.recordForPayment.execute({ eventId: event.id, eventType: event.type, payload: event.payload, toIntent });
    });
  }

  private onDriver<T extends { driverId: string }>(
    eventType: string,
    toIntent: (payload: T, driverUserId: string) => NotificationIntent,
  ): void {
    this.bus.subscribe<T>(eventType, async (event: DomainEvent<T>) => {
      await this.recordForDriver.execute({ eventId: event.id, eventType: event.type, payload: event.payload, toIntent });
    });
  }

  private onPrescription<T>(
    eventType: string,
    subjectOf: (payload: T) => PrescriptionSubject,
    toIntent: (payload: T, customerUserId: string) => NotificationIntent,
  ): void {
    this.bus.subscribe<T>(eventType, async (event: DomainEvent<T>) => {
      await this.recordForPrescription.execute({
        eventId: event.id,
        eventType: event.type,
        payload: event.payload,
        subject: subjectOf(event.payload),
        toIntent,
      });
    });
  }

  private onPharmacy<T extends { pharmacyId: string }>(
    eventType: string,
    toIntent: (payload: T, ownerUserId: string) => NotificationIntent,
  ): void {
    this.bus.subscribe<T>(eventType, async (event: DomainEvent<T>) => {
      await this.recordForPharmacy.execute({ eventId: event.id, eventType: event.type, payload: event.payload, toIntent });
    });
  }
}
