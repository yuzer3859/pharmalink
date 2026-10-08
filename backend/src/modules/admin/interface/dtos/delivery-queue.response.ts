import {
  DeliveryAttemptView,
  DeliveryJobPage,
  DeliveryJobView,
  DeliveryQueueSummary,
} from '../../../notifications/application/ports/inbound/notification-delivery-admin.port';

/** One delivery job — operational columns only; no recipient, content or provider data. */
export interface DeliveryJobResponse {
  id: string;
  notificationId: string;
  channel: string;
  status: string;
  attemptCount: number;
  nextAttemptAt: string;
  leaseExpiresAt: string | null;
  lastErrorCode: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DeliveryJobListResponse {
  items: DeliveryJobResponse[];
  total: number;
  page: number;
  size: number;
}

/** One history row — never `errorDetail`; the provider message id only as its last 8 characters. */
export interface DeliveryAttemptResponse {
  id: string;
  attemptNumber: number;
  channel: string;
  provider: string | null;
  providerMessageIdSuffix: string | null;
  status: string;
  errorCode: string | null;
  attemptedAt: string;
}

export interface DeliveryQueueSummaryResponse {
  generatedAt: string;
  jobs: { total: number; byStatus: Record<string, number>; byChannel: Record<string, number> };
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

// Explicit allow-lists, never spreads.
export function toDeliveryJobResponse(j: DeliveryJobView): DeliveryJobResponse {
  return {
    id: j.id,
    notificationId: j.notificationId,
    channel: j.channel,
    status: j.status,
    attemptCount: j.attemptCount,
    nextAttemptAt: j.nextAttemptAt.toISOString(),
    leaseExpiresAt: iso(j.leaseExpiresAt),
    lastErrorCode: j.lastErrorCode,
    completedAt: iso(j.completedAt),
    createdAt: j.createdAt.toISOString(),
    updatedAt: j.updatedAt.toISOString(),
  };
}

export function toDeliveryJobListResponse(p: DeliveryJobPage): DeliveryJobListResponse {
  return { items: p.items.map(toDeliveryJobResponse), total: p.total, page: p.page, size: p.size };
}

export function toDeliveryAttemptResponse(a: DeliveryAttemptView): DeliveryAttemptResponse {
  return {
    id: a.id,
    attemptNumber: a.attemptNumber,
    channel: a.channel,
    provider: a.provider,
    providerMessageIdSuffix: a.providerMessageIdSuffix,
    status: a.status,
    errorCode: a.errorCode,
    attemptedAt: a.attemptedAt.toISOString(),
  };
}

export function toDeliveryQueueSummaryResponse(s: DeliveryQueueSummary): DeliveryQueueSummaryResponse {
  return { generatedAt: s.generatedAt.toISOString(), jobs: { total: s.total, byStatus: { ...s.byStatus }, byChannel: { ...s.byChannel } } };
}
