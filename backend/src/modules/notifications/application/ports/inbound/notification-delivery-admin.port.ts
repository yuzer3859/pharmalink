import { Inject, Injectable } from '@nestjs/common';
import { DeliveryJobStatus, NotificationChannel, NotificationStatus } from '../../../domain/enums';
import {
  DELIVERY_ADMIN_REPOSITORY,
  DeliveryJobRecord,
  DeliveryJobSearchCriteria,
  IDeliveryAdminRepository,
} from '../../../domain/repositories/delivery-admin.repository';

export const NOTIFICATION_DELIVERY_ADMIN_PORT = Symbol('NOTIFICATION_DELIVERY_ADMIN_PORT');

export { DeliveryJobStatus as DeliveryQueueStatus, NotificationChannel as DeliveryQueueChannel } from '../../../domain/enums';
export type { DeliveryJobSearchCriteria } from '../../../domain/repositories/delivery-admin.repository';

/**
 * One delivery job as operations sees it (module-13 Work 20). The job's own columns — none of which
 * is content or contact data. The states are Work 13's, unchanged:
 *
 *  - `PENDING`    waiting: never tried, waiting for a retry, or waiting for a provider to be
 *                 configured (an unconfigured channel's jobs are never even read) — not a failure
 *  - `PROCESSING` claimed by a dispatcher under a lease (`leaseExpiresAt`); due again once it lapses
 *  - `COMPLETED`  terminal: the provider accepted the message (later receipts are in the attempts)
 *  - `SUPPRESSED` terminal: preference disabled, or the destination is suppressed — never sent
 *  - `EXHAUSTED`  terminal: five failed attempts, a non-retryable failure, or nothing deliverable
 */
export type DeliveryJobView = DeliveryJobRecord;

/**
 * One row of a job's delivery history: provider attempts, suppressions and webhook receipts
 * (DELIVERED / BOUNCED). `errorDetail` is never read. `providerMessageIdSuffix` is the last 8
 * characters of the provider's message id: a provider id (e.g. a Resend `email_id`) leads, in the
 * provider's console, to the recipient — the suffix tells rows apart without that.
 */
export interface DeliveryAttemptView {
  id: string;
  attemptNumber: number;
  channel: NotificationChannel;
  provider: string | null;
  providerMessageIdSuffix: string | null;
  status: NotificationStatus;
  errorCode: string | null;
  attemptedAt: Date;
}

export interface DeliveryJobPage {
  items: DeliveryJobView[];
  total: number;
  page: number;
  size: number;
}

/** Exact counts of delivery jobs, by the database at `generatedAt`. Statuses / channels with no job are listed with 0. */
export interface DeliveryQueueSummary {
  generatedAt: Date;
  total: number;
  byStatus: Record<DeliveryJobStatus, number>;
  byChannel: Record<'PUSH' | 'SMS' | 'EMAIL', number>;
}

/**
 * Module 13's exported, **read-only** contract for notification delivery operations (module-13
 * Work 20), consumed by Module 16's admin control plane. Jobs, one job's history, and counts — no
 * retry, cancel, delete or send; no notification content, recipient, provider credential or raw
 * provider data.
 */
export interface INotificationDeliveryAdminPort {
  listJobs(criteria: DeliveryJobSearchCriteria, page: number, size: number): Promise<DeliveryJobPage>;
  getJob(id: string): Promise<DeliveryJobView | null>;
  /** The job's history, oldest first — `null` when there is no such job. */
  attemptsOfJob(id: string): Promise<DeliveryAttemptView[] | null>;
  summary(): Promise<DeliveryQueueSummary>;
}

const suffix = (id: string | null) => (id ? `…${id.slice(-8)}` : null);

/** `INotificationDeliveryAdminPort` over Module 13's own read repository. */
@Injectable()
export class NotificationDeliveryAdminPortAdapter implements INotificationDeliveryAdminPort {
  constructor(@Inject(DELIVERY_ADMIN_REPOSITORY) private readonly deliveries: IDeliveryAdminRepository) {}

  async listJobs(criteria: DeliveryJobSearchCriteria, page: number, size: number): Promise<DeliveryJobPage> {
    const { items, total } = await this.deliveries.listJobs(criteria, page, size);
    return { items, total, page, size };
  }

  getJob(id: string): Promise<DeliveryJobView | null> {
    return this.deliveries.findJob(id);
  }

  async attemptsOfJob(id: string): Promise<DeliveryAttemptView[] | null> {
    const job = await this.deliveries.findJob(id);
    if (!job) return null;
    const rows = await this.deliveries.attemptsOf(job.notificationId, job.channel);
    return rows.map((r) => ({
      id: r.id,
      attemptNumber: r.attemptNumber,
      channel: r.channel,
      provider: r.provider,
      providerMessageIdSuffix: suffix(r.providerMessageId),
      status: r.status,
      errorCode: r.errorCode,
      attemptedAt: r.attemptedAt,
    }));
  }

  async summary(): Promise<DeliveryQueueSummary> {
    const generatedAt = new Date();
    const counts = await this.deliveries.countJobs();
    const byStatus = Object.fromEntries(Object.values(DeliveryJobStatus).map((s) => [s, 0])) as Record<DeliveryJobStatus, number>;
    for (const s of counts.byStatus) byStatus[s.status] = s.count;
    const byChannel = { PUSH: 0, SMS: 0, EMAIL: 0 };
    for (const c of counts.byChannel) if (c.channel in byChannel) byChannel[c.channel as keyof typeof byChannel] = c.count;
    return { generatedAt, total: counts.total, byStatus, byChannel };
  }
}
