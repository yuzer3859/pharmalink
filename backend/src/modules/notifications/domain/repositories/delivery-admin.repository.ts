import { DeliveryJobStatus, NotificationChannel, NotificationStatus } from '../enums';

export const DELIVERY_ADMIN_REPOSITORY = Symbol('DELIVERY_ADMIN_REPOSITORY');

/** One `notification_delivery_jobs` row — every column, none of which is content or contact data. */
export interface DeliveryJobRecord {
  id: string;
  notificationId: string;
  channel: NotificationChannel;
  status: DeliveryJobStatus;
  attemptCount: number;
  nextAttemptAt: Date;
  leaseExpiresAt: Date | null;
  lastErrorCode: string | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** One `delivery_attempts` row, minus `errorDetail` — never read by this port. */
export interface DeliveryAttemptAdminRecord {
  id: string;
  attemptNumber: number;
  channel: NotificationChannel;
  provider: string | null;
  providerMessageId: string | null;
  status: NotificationStatus;
  errorCode: string | null;
  attemptedAt: Date;
}

export interface DeliveryJobSearchCriteria {
  channel?: NotificationChannel;
  status?: DeliveryJobStatus;
  notificationId?: string;
  createdFrom?: Date;
  createdTo?: Date;
  nextAttemptFrom?: Date;
  nextAttemptTo?: Date;
}

export interface DeliveryJobCounts {
  total: number;
  byStatus: Array<{ status: DeliveryJobStatus; count: number }>;
  byChannel: Array<{ channel: NotificationChannel; count: number }>;
}

/**
 * Read-only administrative port over `notification_delivery_jobs` and `delivery_attempts`
 * (module-13 Work 20). No write of any kind; counts are aggregated by the database.
 */
export interface IDeliveryAdminRepository {
  listJobs(criteria: DeliveryJobSearchCriteria, page: number, size: number): Promise<{ items: DeliveryJobRecord[]; total: number }>;
  findJob(id: string): Promise<DeliveryJobRecord | null>;
  /** The history of one job's (notification, channel) — provider attempts, suppressions and receipts. */
  attemptsOf(notificationId: string, channel: NotificationChannel): Promise<DeliveryAttemptAdminRecord[]>;
  countJobs(): Promise<DeliveryJobCounts>;
}
