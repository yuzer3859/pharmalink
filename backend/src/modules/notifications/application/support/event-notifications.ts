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
import type {
  CodCorrectionRecordedPayload,
  CodReconciledPayload,
  CodRemittedPayload,
  DeliveryFailedPayload,
  DeliveryStatusPayload,
  EarningAccruedPayload,
  JobOfferedPayload,
} from '../../../delivery/domain/events';
import type {
  MatchFailedPayload,
  PrescriptionApprovedPayload,
  PrescriptionRejectedPayload,
} from '../../../prescription-matching/domain/events';
import type { PharmacyActivatedPayload, PharmacySuspendedPayload } from '../../../pharmacy-inventory/domain/events';
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

/**
 * Event → notification for the driver side of Module 08 (module-13 Work 05). Every event names
 * its driver by `driver_profiles.id`; the recipient is that profile's Module 01 user, resolved by
 * Module 08's `DRIVER_RECIPIENT_READ_PORT` and supplied by the caller.
 *
 * `jobId` is kept on every one: it is the handle the driver's own surface is keyed by
 * (`/delivery/jobs/:id/...`, `/driver/jobs`), so it is what the notification links to. Never kept,
 * on any of them: `driverId` (the recipient already is the driver), `orderId`/`fulfillmentId`
 * (the customer's and pharmacy's handles), operator ids (`confirmedByUserId`, `reconciledByUserId`,
 * `createdByUserId`), `providerReference`, `collectionId`/`remittanceId`/`reconciliationId`/
 * `correctionId`/`earningId`, and `calculationVersion`. Per event:
 *
 * - offer — `expiresAt`, the deadline the offer is answered against. Not `offerId` or `round`.
 * - earning — `amount`, `currency`: what is owed and recorded, not what was paid.
 * - remitted — `remittedAmount`, `currency`, `reference` (the PharmaLink handover handle, the
 *   driver's receipt). Not the expected/collected figures or the method.
 * - reconciled — `outcome` only. No amounts.
 * - correction — `correctionType` only. Not the operator's `reason`, the original/corrected
 *   amounts or references: the correction's detail is the finance record's, not a notification's.
 */
export const DriverNotifications = {
  jobOffered: (p: JobOfferedPayload, driverUserId: string): NotificationIntent => ({
    recipientUserId: driverUserId,
    templateCode: NotificationTemplateCode.DRIVER_JOB_OFFERED,
    data: { jobId: p.jobId, expiresAt: p.expiresAt },
  }),

  earningAccrued: (p: EarningAccruedPayload, driverUserId: string): NotificationIntent => ({
    recipientUserId: driverUserId,
    templateCode: NotificationTemplateCode.DRIVER_EARNING_ACCRUED,
    data: { jobId: p.jobId, amount: p.amount, currency: p.currency },
  }),

  codRemitted: (p: CodRemittedPayload, driverUserId: string): NotificationIntent => ({
    recipientUserId: driverUserId,
    templateCode: NotificationTemplateCode.DRIVER_COD_REMITTED,
    data: { jobId: p.jobId, remittedAmount: p.remittedAmount, currency: p.currency, reference: p.reference },
  }),

  codReconciled: (p: CodReconciledPayload, driverUserId: string): NotificationIntent => ({
    recipientUserId: driverUserId,
    templateCode: NotificationTemplateCode.DRIVER_COD_RECONCILED,
    data: { jobId: p.jobId, outcome: p.outcome },
  }),

  codCorrectionRecorded: (p: CodCorrectionRecordedPayload, driverUserId: string): NotificationIntent => ({
    recipientUserId: driverUserId,
    templateCode: NotificationTemplateCode.DRIVER_COD_CORRECTION_RECORDED,
    data: { jobId: p.jobId, correctionType: p.type },
  }),
};

/**
 * Event → notification for Module 05 (module-13 Work 06). The prescription events name only the
 * prescription and the matching event only the match request; the customer is resolved by Module
 * 05's `PRESCRIPTION_RECIPIENT_READ_PORT` and supplied by the caller.
 *
 * Kept: the handle the customer's own surface is keyed by (`prescriptionId` →
 * `GET /prescriptions/:id`, `matchRequestId` → `GET /matching/:id`), and on a rejection the
 * pharmacist's `reason` — Module 05 records it for the customer (BRULE-14, BR-RX-05) and already
 * returns it to them as `rejectionReason`. Never kept: the approved `lines` (catalogue products and
 * quantities are medical detail), and nothing else of either record — no file reference, reviewer,
 * pharmacy or matching diagnostic is even on these events.
 */
export const PrescriptionNotifications = {
  prescriptionApproved: (p: PrescriptionApprovedPayload, customerUserId: string): NotificationIntent => ({
    recipientUserId: customerUserId,
    templateCode: NotificationTemplateCode.PRESCRIPTION_APPROVED,
    data: { prescriptionId: p.prescriptionId },
  }),

  prescriptionRejected: (p: PrescriptionRejectedPayload, customerUserId: string): NotificationIntent => ({
    recipientUserId: customerUserId,
    templateCode: NotificationTemplateCode.PRESCRIPTION_REJECTED,
    data: { prescriptionId: p.prescriptionId, reason: p.reason ?? null },
  }),

  matchFailed: (p: MatchFailedPayload, customerUserId: string): NotificationIntent => ({
    recipientUserId: customerUserId,
    templateCode: NotificationTemplateCode.MATCHING_FAILED,
    data: { matchRequestId: p.matchRequestId },
  }),
};

/**
 * Event → notification for Module 04's pharmacy state changes (module-13 Work 07). The recipient
 * is the pharmacy's organization owner, resolved by Module 04's `PHARMACY_RECIPIENT_READ_PORT` and
 * supplied by the caller.
 *
 * Kept: `pharmacyId` (the owner's handle on their pharmacy), and on a suspension its `reason` — a
 * platform code (`LICENSE_EXPIRED` | `MANUAL`), not free text. Not kept: `organizationId` (the
 * recipient's own organization adds nothing for them).
 */
export const PharmacyNotifications = {
  pharmacyActivated: (p: PharmacyActivatedPayload, ownerUserId: string): NotificationIntent => ({
    recipientUserId: ownerUserId,
    templateCode: NotificationTemplateCode.PHARMACY_ACTIVATED,
    data: { pharmacyId: p.pharmacyId },
  }),

  pharmacySuspended: (p: PharmacySuspendedPayload, ownerUserId: string): NotificationIntent => ({
    recipientUserId: ownerUserId,
    templateCode: NotificationTemplateCode.PHARMACY_SUSPENDED,
    data: { pharmacyId: p.pharmacyId, reason: p.reason },
  }),
};

/** One event delivered to one recipient is one notification, however often it is delivered. */
export function dedupeKeyFor(eventId: string, recipientUserId: string): string {
  return `${eventId}:${recipientUserId}`;
}
