import { Inject, Injectable } from '@nestjs/common';
import {
  INotificationSuppressionAdminPort,
  NOTIFICATION_SUPPRESSION_ADMIN_PORT,
  SuppressionPage,
  SuppressionSearchCriteria,
} from '../../../notifications/application/ports/inbound/notification-suppression-admin.port';

export const DEFAULT_SUPPRESSION_PAGE = 1;
export const DEFAULT_SUPPRESSION_PAGE_SIZE = 20;
export const MAX_SUPPRESSION_PAGE_SIZE = 100;

export interface ListSuppressionsInput extends SuppressionSearchCriteria {
  page?: number;
  size?: number;
}

/**
 * `GET /admin/notifications/suppressions` (module-13 Work 19): Module 13's suppression list, newest
 * first, through `NOTIFICATION_SUPPRESSION_ADMIN_PORT`. Paging is clamped here as every Module 16
 * list is (1..100, default 20) — the DTO refuses out-of-range values, this guards other callers.
 * Not audited: Module 16 has no sensitive-read audit convention, and the rows carry no destination.
 */
@Injectable()
export class ListSuppressionsQuery {
  constructor(@Inject(NOTIFICATION_SUPPRESSION_ADMIN_PORT) private readonly suppressions: INotificationSuppressionAdminPort) {}

  execute(input: ListSuppressionsInput): Promise<SuppressionPage> {
    const page = input.page !== undefined && Number.isFinite(input.page) && input.page > 0 ? Math.floor(input.page) : DEFAULT_SUPPRESSION_PAGE;
    const size =
      input.size !== undefined && Number.isFinite(input.size) && input.size > 0
        ? Math.min(Math.floor(input.size), MAX_SUPPRESSION_PAGE_SIZE)
        : DEFAULT_SUPPRESSION_PAGE_SIZE;
    return this.suppressions.listSuppressions(
      { channel: input.channel, reason: input.reason, createdFrom: input.createdFrom, createdTo: input.createdTo },
      page,
      size,
    );
  }
}
