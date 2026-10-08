import { NotificationChannel } from '../enums';

export const SUPPRESSION_ADMIN_REPOSITORY = Symbol('SUPPRESSION_ADMIN_REPOSITORY');

/** One `suppression_list` row as stored — `address` is the suppression key, not shown to anyone. */
export interface SuppressionRecord {
  id: string;
  channel: NotificationChannel;
  address: string;
  reason: string | null;
  createdAt: Date;
}

/** Filters on stored columns only. */
export interface SuppressionSearchCriteria {
  channel?: NotificationChannel;
  reason?: string;
  createdFrom?: Date;
  createdTo?: Date;
}

/**
 * Administrative persistence port for `suppression_list` (module-13 Work 19): list, read and remove
 * by row id. No lookup by address or key — an operator finds a suppression by its row, never by
 * probing destinations.
 */
export interface ISuppressionAdminRepository {
  list(criteria: SuppressionSearchCriteria, page: number, size: number): Promise<{ items: SuppressionRecord[]; total: number }>;
  findById(id: string): Promise<SuppressionRecord | null>;
  /** Deletes the row; returns it, or `null` when it was already gone (including a concurrent removal). */
  deleteById(id: string): Promise<SuppressionRecord | null>;
}
