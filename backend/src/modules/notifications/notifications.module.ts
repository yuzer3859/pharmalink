import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module';
import { OrdersModule } from '../orders/orders.module';
import { MarkAllNotificationsReadCommand } from './application/commands/mark-all-notifications-read.command';
import { MarkNotificationReadCommand } from './application/commands/mark-notification-read.command';
import { RecordNotificationCommand } from './application/commands/record-notification.command';
import { RecordOrderNotificationCommand } from './application/commands/record-order-notification.command';
import { GetUnreadCountQuery } from './application/queries/get-unread-count.query';
import { ListNotificationsQuery } from './application/queries/list-notifications.query';
import { NOTIFICATION_REPOSITORY } from './domain/repositories/notification.repository';
import { PrismaNotificationRepository } from './infrastructure/persistence/prisma-notification.repository';
import { NotificationsController } from './interface/controllers/notifications.controller';
import { NotificationEventsHandler } from './interface/events/notification-events.handler';

/**
 * Module 13 — Notifications & Communication. Work 01: the in-app notification center. Work 02:
 * customer notifications for the order lifecycle (accepted, ready, cancelled).
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
 * The event contracts (`identity/domain/events`, `orders/domain/events`), Module 01's language
 * port and Module 06's recipient port are the only things it takes from other modules;
 * `IdentityModule` is imported for the language port and `@CurrentUser`, `OrdersModule` for the
 * recipient port.
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
 * notification routes, and the events whose recipient lookup has no contract yet — payment,
 * delivery, prescription, matching, pharmacy and driver events.
 */
@Module({
  imports: [IdentityModule, OrdersModule],
  controllers: [NotificationsController],
  providers: [
    { provide: NOTIFICATION_REPOSITORY, useClass: PrismaNotificationRepository },

    RecordNotificationCommand,
    RecordOrderNotificationCommand,
    MarkNotificationReadCommand,
    MarkAllNotificationsReadCommand,
    ListNotificationsQuery,
    GetUnreadCountQuery,

    NotificationEventsHandler,
  ],
})
export class NotificationsModule {}
