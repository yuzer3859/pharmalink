import type {
  AccountStatusChangedPayload,
  LicenseExpiredPayload,
  ProviderDecisionPayload,
} from '../../../identity/domain/events';
import type {
  OrderAcceptedPayload,
  OrderCancelledPayload,
  OrderPlacedPayload,
  OrderReadyPayload,
} from '../../../orders/domain/events';
import type {
  PaymentCapturedPayload,
  PaymentFailedPayload,
  PaymentRefundedPayload,
} from '../../../payment/domain/events';
import type { PaymentRecipientView } from '../../../payment/application/ports/inbound/payment-recipient-read.port';
import type { DeliveryFailedPayload, DeliveryStatusPayload } from '../../../delivery/domain/events';
import { NotificationData, NotificationTemplateCode } from '../../domain/templates';

/** What one event asks Module 13 to tell one recipient. */
export interface NotificationIntent {
  recipientUserId: string;
  templateCode: NotificationTemplateCode;
  data: NotificationData;
}

/**
 * Event → notification, for the six events whose payload already names the recipient
 * (module-13 Work 01). Each mapping copies an explicit allow-list of fields into `data`; nothing
 * else from the event is kept. Not kept, on purpose:
 *
 * - `reviewerId` / `actorUserId` — who acted is the platform's business, not the recipient's.
 * - A suspension's `reason` — written by an administrator (or a sweep, as `LICENSE_EXPIRED:<type>`)
 *   for the audit trail, not addressed to the user. A verification rejection's `reason` *is*
 *   addressed to the applicant — Module 01 already reports it back on `/verification/status` —
 *   so that one is kept.
 * - `organizationId` and `customerUserId` — the recipient is the notification's owner already.
 */
export const EventNotifications = {
  providerApproved: (p: ProviderDecisionPayload): NotificationIntent => ({
    recipientUserId: p.userId,
    templateCode: NotificationTemplateCode.PROVIDER_VERIFICATION_APPROVED,
    data: { verificationRequestId: p.verificationRequestId, verificationType: p.verificationType },
  }),

  providerRejected: (p: ProviderDecisionPayload): NotificationIntent => ({
    recipientUserId: p.userId,
    templateCode: NotificationTemplateCode.PROVIDER_VERIFICATION_REJECTED,
    data: {
      verificationRequestId: p.verificationRequestId,
      verificationType: p.verificationType,
      reason: p.reason ?? null,
    },
  }),

  licenseExpired: (p: LicenseExpiredPayload): NotificationIntent => ({
    recipientUserId: p.userId,
    templateCode: NotificationTemplateCode.PROVIDER_LICENSE_EXPIRED,
    data: {
      verificationRequestId: p.verificationRequestId,
      verificationType: p.verificationType,
      expiredAt: p.expiredAt,
    },
  }),

  accountSuspended: (p: AccountStatusChangedPayload): NotificationIntent => ({
    recipientUserId: p.userId,
    templateCode: NotificationTemplateCode.ACCOUNT_SUSPENDED,
    data: {},
  }),

  accountReactivated: (p: AccountStatusChangedPayload): NotificationIntent => ({
    recipientUserId: p.userId,
    templateCode: NotificationTemplateCode.ACCOUNT_REACTIVATED,
    data: {},
  }),

  orderPlaced: (p: OrderPlacedPayload): NotificationIntent => ({
    recipientUserId: p.customerUserId,
    templateCode: NotificationTemplateCode.ORDER_PLACED,
    data: { orderId: p.orderId, grandTotal: p.totals.grandTotal, currency: p.totals.currency },
  }),
};

/**
 * Event → notification for the order lifecycle events that carry the `orderId` but not the
 * customer (module-13 Work 02). The recipient is supplied by the caller, resolved through Module
 * 06's `ORDER_RECIPIENT_READ_PORT` — never taken from anywhere else. `fulfillmentId` and
 * `pharmacyId` are not kept: the customer's notification is about their order.
 */
export const OrderLifecycleNotifications = {
  orderAccepted: (p: OrderAcceptedPayload, customerUserId: string): NotificationIntent => ({
    recipientUserId: customerUserId,
    templateCode: NotificationTemplateCode.ORDER_ACCEPTED,
    data: { orderId: p.orderId },
  }),

  orderReady: (p: OrderReadyPayload, customerUserId: string): NotificationIntent => ({
    recipientUserId: customerUserId,
    templateCode: NotificationTemplateCode.ORDER_READY,
    data: { orderId: p.orderId },
  }),

  /** `reason` is kept because the event carries it; the template words only `NO_PHARMACY_MATCH`. */
  orderCancelled: (p: OrderCancelledPayload, customerUserId: string): NotificationIntent => ({
    recipientUserId: customerUserId,
    templateCode: NotificationTemplateCode.ORDER_CANCELLED,
    data: { orderId: p.orderId, reason: p.reason ?? null },
  }),
};

/**
 * Event → notification for the payment events (module-13 Work 03). `payment.captured` and
 * `payment.failed` carry the `orderId`, so their recipient is the order's customer from Module 06's
 * `ORDER_RECIPIENT_READ_PORT`; `payment.refunded` carries only the `paymentId`, so its recipient,
 * order and currency come from Module 07's `PAYMENT_RECIPIENT_READ_PORT`.
 *
 * Not kept: `fee` (the platform's commission on the capture — the platform's accounting, not the
 * customer's), and anything a payment row holds beyond the view above. `reason` on a failure is
 * kept: Module 07 defines it as a sanitized, customer-safe sentence and already returns it to the
 * customer on `GET /payments/:id`.
 */
export const PaymentNotifications = {
  paymentCaptured: (p: PaymentCapturedPayload, customerUserId: string): NotificationIntent => ({
    recipientUserId: customerUserId,
    templateCode: NotificationTemplateCode.PAYMENT_CAPTURED,
    data: { paymentId: p.paymentId, orderId: p.orderId },
  }),

  paymentFailed: (p: PaymentFailedPayload, customerUserId: string): NotificationIntent => ({
    recipientUserId: customerUserId,
    templateCode: NotificationTemplateCode.PAYMENT_FAILED,
    data: { paymentId: p.paymentId, orderId: p.orderId, reason: p.reason ?? null },
  }),

  paymentRefunded: (p: PaymentRefundedPayload, payment: PaymentRecipientView): NotificationIntent => ({
    recipientUserId: payment.customerUserId,
    templateCode: NotificationTemplateCode.PAYMENT_REFUNDED,
    data: { paymentId: p.paymentId, orderId: payment.orderId, amount: p.amount, currency: payment.currency },
  }),
};

/**
 * Event → notification for the customer side of Module 08's status workflow (module-13 Work 04).
 * Every event names the order, so the recipient is the order's customer from Module 06's
 * `ORDER_RECIPIENT_READ_PORT` — the Work 02 path, unchanged. Module 08 is never asked.
 *
 * `data` is `{ orderId }` and nothing else. Not kept: `driverId` (a `driver_profiles.id` — the
 * customer is not addressed by, and does not need, the courier's identifier), `jobId` and
 * `fulfillmentId` (internal delivery and fulfillment handles), `status` (the template already is
 * the status), and on a failure the `reason` — free text the driver types, which no contract
 * defines as customer-safe.
 */
const deliveryIntent =
  (templateCode: NotificationTemplateCode) =>
  (p: DeliveryStatusPayload, customerUserId: string): NotificationIntent => ({
    recipientUserId: customerUserId,
    templateCode,
    data: { orderId: p.orderId },
  });

export const DeliveryNotifications = {
  orderPickedUp: deliveryIntent(NotificationTemplateCode.DELIVERY_PICKED_UP),
  orderEnRoute: deliveryIntent(NotificationTemplateCode.DELIVERY_EN_ROUTE),
  orderDelivered: deliveryIntent(NotificationTemplateCode.DELIVERY_DELIVERED),
  deliveryFailed: deliveryIntent(NotificationTemplateCode.DELIVERY_FAILED) as (
    p: DeliveryFailedPayload,
    customerUserId: string,
  ) => NotificationIntent,
};

/** One event delivered to one recipient is one notification, however often it is delivered. */
export function dedupeKeyFor(eventId: string, recipientUserId: string): string {
  return `${eventId}:${recipientUserId}`;
}
