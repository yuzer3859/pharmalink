import { Inject, Injectable } from '@nestjs/common';
import {
  AUDIT_READ_PORT,
  AuditPage,
  AuditSearchFilter,
  IAuditReadPort,
} from '../../../../shared/audit/audit-read.port';

export const DEFAULT_AUDIT_PAGE = 1;
export const DEFAULT_AUDIT_PAGE_SIZE = 20;
export const MAX_AUDIT_PAGE_SIZE = 100;

export interface ListAuditInput {
  action?: string;
  actorUserId?: string;
  resourceType?: string;
  resourceId?: string;
  from?: Date;
  to?: Date;
  page?: number;
  size?: number;
}

/**
 * `GET /admin/audit` (module-16 §9.7, F-AD-26) — the hash-chained trail, read-only, newest first.
 *
 * Every filter is a column of `audit_logs`; nothing is searched inside `context`, because it is
 * free-form JSON with no shape shared across the modules that write it. Reading the trail writes
 * nothing to it: the repository has no sensitive-read audit convention (no module records a
 * `*_VIEWED` action), and inventing one here would put every investigation into the trail being
 * investigated.
 */
@Injectable()
export class ListAuditQuery {
  constructor(@Inject(AUDIT_READ_PORT) private readonly audit: IAuditReadPort) {}

  execute(input: ListAuditInput): Promise<AuditPage> {
    const page =
      input.page !== undefined && Number.isFinite(input.page) && input.page > 0
        ? Math.floor(input.page)
        : DEFAULT_AUDIT_PAGE;
    const size =
      input.size !== undefined && Number.isFinite(input.size) && input.size > 0
        ? Math.min(Math.floor(input.size), MAX_AUDIT_PAGE_SIZE)
        : DEFAULT_AUDIT_PAGE_SIZE;

    const filter: AuditSearchFilter = {
      action: input.action,
      actorUserId: input.actorUserId,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      from: input.from,
      to: input.to,
    };
    return this.audit.search(filter, page, size);
  }
}
