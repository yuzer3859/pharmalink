import { Module } from '@nestjs/common';
import { DeliveryModule } from '../delivery/delivery.module';
import { IdentityModule } from '../identity/identity.module';
import { OrdersModule } from '../orders/orders.module';
import { PaymentModule } from '../payment/payment.module';
import { PrescriptionMatchingModule } from '../prescription-matching/prescription-matching.module';
import { MarkAllNotificationsReadCommand } from './application/commands/mark-all-notifications-read.command';
import { MarkNotificationReadCommand } from './application/commands/mark-notification-read.command';
import { RecordNotificationCommand } from './application/commands/record-notification.command';
import { RecordOrderNotificationCommand } from './application/commands/record-order-notification.command';
import { RecordPaymentNotificationCommand } from './application/commands/record-payment-notification.command';
import { RecordDriverNotificationCommand } from './application/commands/record-driver-notification.command';
import { RecordPrescriptionNotificationCommand } from './application/commands/record-prescription-notification.command';
import { GetUnreadCountQuery } from './application/queries/get-unread-count.query';
import { ListNotificationsQuery } from './application/queries/list-notifications.query';
import { NOTIFICATION_REPOSITORY } from './domain/repositories/notification.repository';
import { PrismaNotificationRepository } from './infrastructure/persistence/prisma-notification.repository';
import { NotificationsController } from './interface/controllers/notifications.controller';
import { NotificationEventsHandler } from './interface/events/notification-events.handler';

/**
 * Module 13 — Notifications & Communication. Work 01: the in-app notification center. Work 02:
 * customer notifications for the order lifecycle (accepted, ready, cancelled). Work 03: customer
 * notifications for payments (captured, failed, refunded). Work 04: customer notifications for
 * delivery (picked up, en route, delivered, failed). Work 05: driver notifications (job offer,
 * earning accrued, COD remitted, reconciled, corrected). Work 06: customer notifications for
 * prescriptions (approved, rejected) and matching (no pharmacy found).
 *
 * ## What it owns
 *
 * The `notifications` table (`13-notifications.prisma`), and only for the `IN_APP` channel: rows
 * are written `SENT` and become `READ`. The schema already carried everything this needs — a
 * unique `dedupeKey`, `templateCode`, `eventType`, a JSON `payload` and the rendered title and
 * body — so there is no migration.
 *
 * ## How a notification is made
 *
 *     Module 01 / 06 command ─outbox→ OutboxRelay ─→ EventBus ─→ NotificationEventsHandler
 *         → EventNotifications (recipient from the payload, allow-listed data)
 *         → RecordNotificationCommand
 *              ├─ IDENTITY_LANGUAGE_READ_PORT  (Module 01: preferredLanguage, am | en)
 *              ├─ NOTIFICATION_TEMPLATES       (code-owned am/en catalogue)
 *              └─ INSERT … ON CONFLICT (dedupeKey = eventId:recipientUserId) DO NOTHING
 *
 * Work 02's events name the order, not the customer, so one step precedes the above:
 *
 *     order.accepted | order.ready | order.cancelled ─→ RecordOrderNotificationCommand
 *         ├─ ORDER_RECIPIENT_READ_PORT (Module 06: the order's customerUserId; unknown → skip + warn)
 *         └─→ RecordNotificationCommand (as above)
 *
 * Work 03: `payment.captured` and `payment.failed` — and Work 04's four delivery status events —
 * name the order and take the same path;
 * `payment.refunded` names only the payment:
 *
 *     payment.refunded ─→ RecordPaymentNotificationCommand
 *         ├─ PAYMENT_RECIPIENT_READ_PORT (Module 07: customerUserId, orderId, currency; unknown → skip + warn)
 *         └─→ RecordNotificationCommand (as above)
 *
 * Work 05's driver events name a `driver_profiles.id`, not a person:
 *
 *     delivery.job.offered | .earning.accrued | .cod.remitted | .cod.reconciled
 *       | .cod.correction_recorded ─→ RecordDriverNotificationCommand
 *         ├─ DRIVER_RECIPIENT_READ_PORT (Module 08: the profile's userId; unknown → skip + warn)
 *         └─→ RecordNotificationCommand (as above)
 *
 * Work 06's events name a prescription or a match request:
 *
 *     prescription.approved | .rejected | matching.match_failed ─→ RecordPrescriptionNotificationCommand
 *         ├─ PRESCRIPTION_RECIPIENT_READ_PORT (Module 05: customerUserId; unknown → skip + warn)
 *         └─→ RecordNotificationCommand (as above)
 *
 * The event contracts (`identity/domain/events`, `orders/domain/events`, `payment/domain/events`,
 * `delivery/domain/events`),
 * Module 01's language port, and Module 05's, 06's, 07's and 08's recipient ports are the only
 * things it takes from other modules; `IdentityModule` is imported for the language port and
 * `@CurrentUser`, the others for their recipient ports.
 *
 * ## Known limitation — consumer failures are not retried
 *
 * `EventBusService` catches and logs a handler's error, and `OutboxRelay` then marks the event
 * published. A notification whose insert fails (database unavailable mid-handler) is therefore
 * lost, not retried. Left as is in this work by decision; idempotency is in place so that a
 * future retrying consumer can redeliver safely.
 *
 * ## Deliberately absent
 *
 * Push, SMS and email (no provider contract exists), BullMQ and a DLQ, preferences and quiet
 * hours, template CRUD (`notification_templates` stays unused), a WebSocket stream, admin
 * notification routes, and the events whose recipient lookup has no contract yet — pharmacy and
 * wallet events.
 */
@Module({
  imports: [IdentityModule, OrdersModule, PaymentModule, DeliveryModule, PrescriptionMatchingModule],
  controllers: [NotificationsController],
  providers: [
    { provide: NOTIFICATION_REPOSITORY, useClass: PrismaNotificationRepository },

    RecordNotificationCommand,
    RecordOrderNotificationCommand,
    RecordPaymentNotificationCommand,
    RecordDriverNotificationCommand,
    RecordPrescriptionNotificationCommand,
    MarkNotificationReadCommand,
    MarkAllNotificationsReadCommand,
    ListNotificationsQuery,
    GetUnreadCountQuery,

    NotificationEventsHandler,
  ],
})
export class NotificationsModule {}
