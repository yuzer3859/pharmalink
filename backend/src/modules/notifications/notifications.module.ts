import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { DeliveryModule } from '../delivery/delivery.module';
import { IdentityModule } from '../identity/identity.module';
import { OrdersModule } from '../orders/orders.module';
import { PaymentModule } from '../payment/payment.module';
import { PharmacyInventoryModule } from '../pharmacy-inventory/pharmacy-inventory.module';
import { PrescriptionMatchingModule } from '../prescription-matching/prescription-matching.module';
import { MarkAllNotificationsReadCommand } from './application/commands/mark-all-notifications-read.command';
import { MarkNotificationReadCommand } from './application/commands/mark-notification-read.command';
import { RecordNotificationCommand } from './application/commands/record-notification.command';
import { RecordOrderNotificationCommand } from './application/commands/record-order-notification.command';
import { RecordPaymentNotificationCommand } from './application/commands/record-payment-notification.command';
import { RecordDriverNotificationCommand } from './application/commands/record-driver-notification.command';
import { RecordPrescriptionNotificationCommand } from './application/commands/record-prescription-notification.command';
import { RecordPharmacyNotificationCommand } from './application/commands/record-pharmacy-notification.command';
import { UpdateNotificationPreferencesCommand } from './application/commands/update-notification-preferences.command';
import { GetNotificationPreferencesQuery } from './application/queries/get-notification-preferences.query';
import { ManageDeviceTokensCommand } from './application/commands/manage-device-tokens.command';
import { NOTIFICATION_CHANNEL_PROVIDER_REGISTRY } from './application/ports/outbound/notification-channel-provider.port';
import { IPushTransport, PUSH_TRANSPORT } from './application/ports/outbound/push-transport.port';
import { ISmsTransport, SMS_TRANSPORT } from './application/ports/outbound/sms-transport.port';
import { EMAIL_TRANSPORT, IEmailTransport } from './application/ports/outbound/email-transport.port';
import { NotificationDeliveryDispatcher } from './application/services/notification-delivery.dispatcher';
import { GetUnreadCountQuery } from './application/queries/get-unread-count.query';
import { ListNotificationsQuery } from './application/queries/list-notifications.query';
import { DEVICE_TOKEN_REPOSITORY } from './domain/repositories/device-token.repository';
import { NOTIFICATION_DELIVERY_REPOSITORY } from './domain/repositories/notification-delivery.repository';
import { NOTIFICATION_PREFERENCE_REPOSITORY } from './domain/repositories/notification-preference.repository';
import { NOTIFICATION_REPOSITORY } from './domain/repositories/notification.repository';
import { PrismaDeviceTokenRepository } from './infrastructure/persistence/prisma-device-token.repository';
import { PrismaNotificationDeliveryRepository } from './infrastructure/persistence/prisma-notification-delivery.repository';
import { PrismaNotificationPreferenceRepository } from './infrastructure/persistence/prisma-notification-preference.repository';
import { StaticNotificationChannelProviderRegistry } from './infrastructure/providers/notification-channel-provider.registry';
import { PushNotificationProvider } from './infrastructure/providers/push-notification.provider';
import { SmsNotificationProvider } from './infrastructure/providers/sms-notification.provider';
import { EmailNotificationProvider } from './infrastructure/providers/email-notification.provider';
import { ResendEmailTransport } from './infrastructure/email/resend-email.transport';
import { ResendConfig } from './infrastructure/email/resend.config';
import { ProcessEmailDeliveryReportCommand } from './application/commands/process-email-delivery-report.command';
import { DestinationSuppressionService } from './application/services/destination-suppression.service';
import { DESTINATION_SUPPRESSION_REPOSITORY, EMAIL_WEBHOOK_REPOSITORY } from './domain/repositories/email-webhook.repository';
import { PrismaDestinationSuppressionRepository, PrismaEmailWebhookRepository } from './infrastructure/persistence/prisma-email-webhook.repository';
import { ResendWebhookController } from './interface/controllers/resend-webhook.controller';
import { EMAIL_WEBHOOK_READER } from './application/ports/outbound/email-webhook-reader.port';
import { ResendWebhookReader } from './infrastructure/webhooks/resend-webhook.reader';
import { SUPPRESSION_ADMIN_REPOSITORY } from './domain/repositories/suppression-admin.repository';
import { DELIVERY_ADMIN_REPOSITORY } from './domain/repositories/delivery-admin.repository';
import { PrismaDeliveryAdminRepository } from './infrastructure/persistence/prisma-delivery-admin.repository';
import {
  NOTIFICATION_DELIVERY_ADMIN_PORT,
  NotificationDeliveryAdminPortAdapter,
} from './application/ports/inbound/notification-delivery-admin.port';
import {
  NOTIFICATION_SUPPRESSION_ADMIN_PORT,
  NotificationSuppressionAdminPortAdapter,
} from './application/ports/inbound/notification-suppression-admin.port';
import { FcmHttpV1Transport } from './infrastructure/push/fcm-http-v1.transport';
import { FcmConfig } from './infrastructure/push/fcm.config';
import { UnconfiguredSmsTransport } from './infrastructure/sms/unconfigured-sms.transport';
import { NotificationDeliveryScheduler } from './infrastructure/scheduling/notification-delivery.scheduler';
import { PrismaNotificationRepository } from './infrastructure/persistence/prisma-notification.repository';
import { NotificationDevicesController } from './interface/controllers/notification-devices.controller';
import { NotificationPreferencesController } from './interface/controllers/notification-preferences.controller';
import { NotificationsController } from './interface/controllers/notifications.controller';
import { NotificationEventsHandler } from './interface/events/notification-events.handler';

/**
 * Module 13 — Notifications & Communication. Work 01: the in-app notification center. Work 02:
 * customer notifications for the order lifecycle (accepted, ready, cancelled). Work 03: customer
 * notifications for payments (captured, failed, refunded). Work 04: customer notifications for
 * delivery (picked up, en route, delivered, failed). Work 05: driver notifications (job offer,
 * earning accrued, COD remitted, reconciled, corrected). Work 06: customer notifications for
 * prescriptions (approved, rejected) and matching (no pharmacy found). Work 07: pharmacy owner
 * notifications (pharmacy activated, suspended). Work 08: wallet notifications (credited,
 * debited) — their events name the user, so they take Work 01's direct path. Work 09: the driver's
 * job-assigned notification, on Work 05's driver path. Work 10: customer matching outcomes (pharmacy
 * found, moved to another pharmacy), on Work 06's path. Work 11: notification preferences — the
 * user's own per-category, per-channel settings — with this module as their single owner. Work
 * 12: the provider-neutral delivery foundation — no provider yet. Work 13: the durable delivery
 * queue (`notification_delivery_jobs`), its dispatcher, scheduler and bounded retry policy. Work
 * 14: push — users register devices (`/notification-devices`, `device_tokens`) and PUSH jobs go out
 * through Firebase Cloud Messaging when its credentials are configured. Work 15: SMS — the
 * provider, Module 01's contact port and the gateway seam; no gateway is approved yet, so SMS jobs wait.
 * Work 16: e-mail — the same shape. Work 17: the e-mail provider is Resend, over its REST API.
 * Work 18: Resend webhooks — delivery receipts, bounces and complaints — and destination suppression.
 * Work 19: `NOTIFICATION_SUPPRESSION_ADMIN_PORT` — list / read / remove suppressions, exported for
 * Module 16's admin control plane. Work 20: `NOTIFICATION_DELIVERY_ADMIN_PORT` — read-only queue
 * visibility (jobs, history, counts) for the same control plane. These two ports are the exports.
 *
 * ## What it owns
 *
 * The `notifications` table (`13-notifications.prisma`), and only for the `IN_APP` channel: rows
 * are written `SENT` and become `READ`. The schema already carried everything this needs — a
 * unique `dedupeKey`, `templateCode`, `eventType`, a JSON `payload` and the rendered title and
 * body — so there is no migration.
 *
 * And, from Work 11, the `channel_preferences` table: the one authority for notification
 * preferences (`domain/preferences.ts` has the policy and the precedence rule). Module 02's
 * `notification_preferences` table predates both and is used by no code; it is left in place,
 * deprecated, for a later migration to drop. Preferences are recorded and served only — no
 * delivery channel consults them yet, and in-app notifications never do.
 *
 * ## Delivery to external channels (Works 12–13)
 *
 *     Notification             — content and the in-app lifecycle (SENT → READ); never changed here
 *     ChannelPreference        — what the user allows (Work 11)
 *     NotificationDeliveryJob  — one per (notification, external channel): the current state
 *     DeliveryAttempt          — immutable history, one row per provider attempt or suppression
 *
 * `RecordNotificationCommand` queues a `PENDING` job, in the same transaction as the notification,
 * for each of PUSH / SMS / EMAIL the preference allows at that moment. `NotificationDeliveryScheduler`
 * runs `NotificationDeliveryDispatcher` every 5 s: it claims due jobs (conditional UPDATE + lease),
 * re-reads the preference, calls the channel's provider and settles the job with a lease-fenced
 * write — `COMPLETED`, `SUPPRESSED`, retry at 30 s / 2 min / 10 min / 30 min, `EXHAUSTED` after the
 * fifth failure (`domain/delivery-retry-policy.ts`). A channel with no provider is not even read:
 * its jobs wait `PENDING`, untouched and attempt-free, until one exists. Notifications recorded
 * before Work 13 have no job and are never swept.
 *
 * Push (Work 14): `PushNotificationProvider` is bound for PUSH **only when `FcmConfig` has all three
 * credentials** (`FCM_PROJECT_ID`, `FCM_CLIENT_EMAIL`, `FCM_PRIVATE_KEY`); without them production
 * behaves exactly as Work 13. It fans one job out to the recipient's active `device_tokens` through
 * `FcmHttpV1Transport` (FCM HTTP v1, 10 s per request, 30 s per delivery — inside the 120 s lease),
 * deactivates tokens FCM reports dead, and closes the job at once when there is no device to reach.
 *
 * SMS (Work 15): `SmsNotificationProvider` texts the notification's rendered body to the recipient's
 * verified phone, read at send time through Module 01's `IDENTITY_CONTACT_READ_PORT` and never
 * stored. No SMS gateway has been approved (architecture open question), so `SMS_TRANSPORT` is
 * `UnconfiguredSmsTransport`, the provider is not registered, and SMS jobs wait `PENDING` until a
 * real transport is bound.
 *
 * E-mail (Work 16): `EmailNotificationProvider` sends a plain-text e-mail — subject the rendered
 * title, body the rendered body — to the recipient's verified address from the same Module 01
 * port. The provider is Resend (Work 17): `EMAIL_TRANSPORT` is `ResendEmailTransport`, configured by
 * `RESEND_API_KEY` and `RESEND_FROM_EMAIL`; without both (or under NODE_ENV=test) it is not
 * configured, the e-mail provider is not registered, and EMAIL jobs wait `PENDING` as before.
 *
 * Webhooks (Work 18): `POST /webhooks/resend` verifies Resend's Svix signature over the raw body
 * (`RESEND_WEBHOOK_SECRET`; absent → every call refused) and `ProcessEmailDeliveryReportCommand`
 * applies each event once by `svix-id` (`notification_webhook_receipts`), correlating `email_id` to
 * the SENT attempt's `providerMsgId`: delivered → a DELIVERED history row; delayed → acknowledged;
 * bounced → BOUNCED, and a permanent bounce suppresses the destination; complained → BOUNCED and
 * suppressed. `suppression_list` keys are SHA-256 hashes of Module 01's canonical address, checked
 * by `EmailNotificationProvider` before every send — a suppressed destination is never mailed, and
 * its job closes SUPPRESSED. Webhooks never create notifications, jobs or resends.
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
 *     delivery.job.offered | .job.assigned | .earning.accrued | .cod.remitted | .cod.reconciled
 *       | .cod.correction_recorded ─→ RecordDriverNotificationCommand
 *         ├─ DRIVER_RECIPIENT_READ_PORT (Module 08: the profile's userId; unknown → skip + warn)
 *         └─→ RecordNotificationCommand (as above)
 *
 * Work 06's events name a prescription or a match request:
 *
 *     prescription.approved | .rejected | matching.match_failed | .order_matched
 *       | .rematch_triggered ─→ RecordPrescriptionNotificationCommand
 *         ├─ PRESCRIPTION_RECIPIENT_READ_PORT (Module 05: customerUserId; unknown → skip + warn)
 *         └─→ RecordNotificationCommand (as above)
 *
 * Work 07's events name a pharmacy; its recipient is the organization owner — a single user:
 *
 *     pharmacy.pharmacy.activated | .suspended ─→ RecordPharmacyNotificationCommand
 *         ├─ PHARMACY_RECIPIENT_READ_PORT (Module 04: owner userId; unknown → skip + warn)
 *         └─→ RecordNotificationCommand (as above)
 *
 * The event contracts (`identity/domain/events`, `orders/domain/events`, `payment/domain/events`,
 * `delivery/domain/events`),
 * Module 01's language port, and Module 04's, 05's, 06's, 07's and 08's recipient ports are the
 * only things it takes from other modules; `IdentityModule` is imported for the language port and
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
 * a real SMS gateway (none approved), BullMQ
 * and a DLQ, quiet hours, digest batching, template CRUD (`notification_templates` stays unused), a WebSocket stream, admin
 * notification routes, pharmacy staff (non-owner) routing, and the events whose recipient lookup
 * has no contract yet — e.g. a new order or an uploaded prescription for a pharmacy.
 */
@Module({
  imports: [
    // Activates `NotificationDeliveryScheduler`'s `@Interval`, as Modules 04, 08 and 16 do for theirs.
    ScheduleModule.forRoot(),
    IdentityModule,
    OrdersModule,
    PaymentModule,
    DeliveryModule,
    PrescriptionMatchingModule,
    PharmacyInventoryModule,
  ],
  controllers: [NotificationsController, NotificationPreferencesController, NotificationDevicesController, ResendWebhookController],
  providers: [
    { provide: NOTIFICATION_REPOSITORY, useClass: PrismaNotificationRepository },
    { provide: NOTIFICATION_PREFERENCE_REPOSITORY, useClass: PrismaNotificationPreferenceRepository },
    { provide: NOTIFICATION_DELIVERY_REPOSITORY, useClass: PrismaNotificationDeliveryRepository },
    { provide: DEVICE_TOKEN_REPOSITORY, useClass: PrismaDeviceTokenRepository },
    FcmConfig,
    { provide: PUSH_TRANSPORT, useClass: FcmHttpV1Transport },
    PushNotificationProvider,
    // No SMS gateway is approved yet: never configured, sends nothing (see SMS_TRANSPORT).
    { provide: SMS_TRANSPORT, useClass: UnconfiguredSmsTransport },
    SmsNotificationProvider,
    // Resend (Work 17): configured only when RESEND_API_KEY and RESEND_FROM_EMAIL are both set.
    ResendConfig,
    { provide: EMAIL_WEBHOOK_REPOSITORY, useClass: PrismaEmailWebhookRepository },
    PrismaDestinationSuppressionRepository,
    { provide: DESTINATION_SUPPRESSION_REPOSITORY, useExisting: PrismaDestinationSuppressionRepository },
    { provide: SUPPRESSION_ADMIN_REPOSITORY, useExisting: PrismaDestinationSuppressionRepository },
    { provide: NOTIFICATION_SUPPRESSION_ADMIN_PORT, useClass: NotificationSuppressionAdminPortAdapter },
    { provide: DELIVERY_ADMIN_REPOSITORY, useClass: PrismaDeliveryAdminRepository },
    { provide: NOTIFICATION_DELIVERY_ADMIN_PORT, useClass: NotificationDeliveryAdminPortAdapter },
    DestinationSuppressionService,
    ProcessEmailDeliveryReportCommand,
    { provide: EMAIL_WEBHOOK_READER, useClass: ResendWebhookReader },
    { provide: EMAIL_TRANSPORT, useClass: ResendEmailTransport },
    EmailNotificationProvider,
    // A channel's provider is bound only when its transport is configured; otherwise its jobs wait
    // PENDING, unread by the dispatcher.
    {
      provide: NOTIFICATION_CHANNEL_PROVIDER_REGISTRY,
      useFactory: (
        pushTransport: IPushTransport,
        push: PushNotificationProvider,
        smsTransport: ISmsTransport,
        sms: SmsNotificationProvider,
        emailTransport: IEmailTransport,
        email: EmailNotificationProvider,
      ) =>
        new StaticNotificationChannelProviderRegistry([
          ...(pushTransport.isConfigured() ? [push] : []),
          ...(smsTransport.isConfigured() ? [sms] : []),
          ...(emailTransport.isConfigured() ? [email] : []),
        ]),
      inject: [PUSH_TRANSPORT, PushNotificationProvider, SMS_TRANSPORT, SmsNotificationProvider, EMAIL_TRANSPORT, EmailNotificationProvider],
    },

    RecordNotificationCommand,
    RecordOrderNotificationCommand,
    RecordPaymentNotificationCommand,
    RecordDriverNotificationCommand,
    RecordPrescriptionNotificationCommand,
    RecordPharmacyNotificationCommand,
    MarkNotificationReadCommand,
    MarkAllNotificationsReadCommand,
    ListNotificationsQuery,
    GetUnreadCountQuery,
    GetNotificationPreferencesQuery,
    UpdateNotificationPreferencesCommand,
    NotificationDeliveryDispatcher,
    ManageDeviceTokensCommand,
    NotificationDeliveryScheduler,

    NotificationEventsHandler,
  ],
  exports: [NOTIFICATION_SUPPRESSION_ADMIN_PORT, NOTIFICATION_DELIVERY_ADMIN_PORT],
})
export class NotificationsModule {}
