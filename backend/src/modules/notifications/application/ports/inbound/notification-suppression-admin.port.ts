import { Inject, Injectable } from '@nestjs/common';
import { AppLogger } from '../../../../../shared/logging/app-logger.service';
import { NotificationChannel } from '../../../domain/enums';
import {
  ISuppressionAdminRepository,
  SUPPRESSION_ADMIN_REPOSITORY,
  SuppressionRecord,
  SuppressionSearchCriteria,
} from '../../../domain/repositories/suppression-admin.repository';
import { SuppressionReason, suppressionFingerprintOf } from '../../../domain/suppression';

export const NOTIFICATION_SUPPRESSION_ADMIN_PORT = Symbol('NOTIFICATION_SUPPRESSION_ADMIN_PORT');

export { NotificationChannel as SuppressionChannel } from '../../../domain/enums';
export { SuppressionReason } from '../../../domain/suppression';
export type { SuppressionSearchCriteria } from '../../../domain/repositories/suppression-admin.repository';

/**
 * One suppression as an operator sees it — what is stored, minus the destination. Neither the
 * address nor its full hash is ever returned: `destinationFingerprint` is the first 8 hex digits of
 * the SHA-256 key, enough to tell rows apart and not enough to look anything up.
 */
export interface SuppressionView {
  id: string;
  channel: NotificationChannel;
  reason: string | null;
  destinationFingerprint: string | null;
  createdAt: Date;
}

export interface SuppressionPage {
  items: SuppressionView[];
  total: number;
  page: number;
  size: number;
}

/**
 * Module 13's exported contract for **administering the suppression list** (module-13 Work 19),
 * consumed in-process by Module 16's admin control plane. List, read and remove by row id — no
 * lookup by address or hash, no creation (suppressions come only from provider reports), no
 * provider detail, no HTTP or caller identity: authorization and the admin audit are the caller's.
 *
 * Removing a suppression only lets **future** sends to that destination be attempted again: jobs
 * already closed `SUPPRESSED`, recorded attempts, webhook receipts and notifications are untouched.
 */
export interface INotificationSuppressionAdminPort {
  listSuppressions(criteria: SuppressionSearchCriteria, page: number, size: number): Promise<SuppressionPage>;
  getSuppression(id: string): Promise<SuppressionView | null>;
  /** The removed suppression, or `null` when there was none with that id (already removed or unknown). */
  removeSuppression(id: string): Promise<SuppressionView | null>;
}

const toView = (r: SuppressionRecord): SuppressionView => ({
  id: r.id,
  channel: r.channel,
  reason: r.reason,
  destinationFingerprint: suppressionFingerprintOf(r.address),
  createdAt: r.createdAt,
});

/** `INotificationSuppressionAdminPort` over Module 13's own suppression repository. */
@Injectable()
export class NotificationSuppressionAdminPortAdapter implements INotificationSuppressionAdminPort {
  constructor(
    @Inject(SUPPRESSION_ADMIN_REPOSITORY) private readonly suppressions: ISuppressionAdminRepository,
    private readonly logger: AppLogger,
  ) {
    this.logger.setContext(NotificationSuppressionAdminPortAdapter.name);
  }

  async listSuppressions(criteria: SuppressionSearchCriteria, page: number, size: number): Promise<SuppressionPage> {
    const { items, total } = await this.suppressions.list(criteria, page, size);
    return { items: items.map(toView), total, page, size };
  }

  async getSuppression(id: string): Promise<SuppressionView | null> {
    const row = await this.suppressions.findById(id);
    return row ? toView(row) : null;
  }

  async removeSuppression(id: string): Promise<SuppressionView | null> {
    const row = await this.suppressions.deleteById(id);
    // The row id and channel only — never the key.
    if (row) this.logger.log(`suppression ${row.id} (${row.channel}, ${row.reason ?? 'no reason'}) removed`);
    return row ? toView(row) : null;
  }
}

/** The reasons this module records, for validating a filter. */
export const SUPPRESSION_REASONS: readonly string[] = Object.values(SuppressionReason);
