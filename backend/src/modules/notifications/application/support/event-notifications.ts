import type {
  AccountStatusChangedPayload,
  LicenseExpiredPayload,
  ProviderDecisionPayload,
} from '../../../identity/domain/events';
import type { OrderPlacedPayload } from '../../../orders/domain/events';
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

/** One event delivered to one recipient is one notification, however often it is delivered. */
export function dedupeKeyFor(eventId: string, recipientUserId: string): string {
  return `${eventId}:${recipientUserId}`;
}
