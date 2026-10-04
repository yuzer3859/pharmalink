import { Inject, Injectable } from '@nestjs/common';
import {
  IDENTITY_ADMIN_PORT,
  IIdentityAdminPort,
  PaginatedResult,
  VerificationSearchFilter,
  VerificationStatus,
  VerificationSummaryView,
  VerificationType,
} from '../../../identity/application/ports/inbound/identity-admin.port';
import { computeAging, VerificationAging } from '../support/verification-aging';

export const DEFAULT_VERIFICATION_PAGE = 1;
export const DEFAULT_VERIFICATION_PAGE_SIZE = 20;
/** Same ceiling as Module 01's own queue — a page is a screen, not an export. */
export const MAX_VERIFICATION_PAGE_SIZE = 100;

export interface ListVerificationQueueInput {
  /** Defaults to `PENDING`: the queue is the work waiting, unless the caller asks for history. */
  status?: VerificationStatus;
  type?: VerificationType;
  userId?: string;
  organizationId?: string;
  submittedFrom?: Date;
  submittedTo?: Date;
  page?: number;
  size?: number;
}

export interface VerificationQueueItemView extends VerificationSummaryView {
  aging: VerificationAging;
}

/**
 * `GET /admin/verifications` (module-16 §9.1, F-AD-01) — the unified queue over every
 * verification type Module 01 defines.
 *
 * Nothing here is Module 16's data. The rows come through `IIdentityAdminPort` as projections
 * Module 01 built — already without the Fayda identifier and without document references — and
 * this query adds exactly one thing to each: its age. The filters are the columns
 * `verification_requests` has (see `VerificationSearchFilter`); the ordering is oldest submission
 * first with a stable tiebreaker, which is the queue's natural order and not a priority rule.
 *
 * Generic on purpose. §4 of the brief says the live product is pharmacies, drivers and customers,
 * and `DOCTOR_LICENSE` requests will not appear until Module 10 submits them — but the queue does
 * not need to know that. It lists whatever Module 01 holds, so a future type arrives here with no
 * change to this file.
 */
@Injectable()
export class ListVerificationQueueQuery {
  constructor(@Inject(IDENTITY_ADMIN_PORT) private readonly identity: IIdentityAdminPort) {}

  async execute(
    input: ListVerificationQueueInput,
    now: Date = new Date(),
  ): Promise<PaginatedResult<VerificationQueueItemView>> {
    const page = sanitizePage(input.page);
    const size = sanitizeSize(input.size);
    const filter: VerificationSearchFilter = {
      status: input.status ?? VerificationStatus.PENDING,
      type: input.type,
      userId: input.userId,
      organizationId: input.organizationId,
      submittedFrom: input.submittedFrom,
      submittedTo: input.submittedTo,
    };

    const result = await this.identity.listVerificationRequests(filter, page, size);
    return {
      ...result,
      items: result.items.map((item) => ({ ...item, aging: computeAging(item, now) })),
    };
  }
}

function sanitizePage(page: number | undefined): number {
  return page !== undefined && Number.isFinite(page) && page > 0
    ? Math.floor(page)
    : DEFAULT_VERIFICATION_PAGE;
}

function sanitizeSize(size: number | undefined): number {
  return size !== undefined && Number.isFinite(size) && size > 0
    ? Math.min(Math.floor(size), MAX_VERIFICATION_PAGE_SIZE)
    : DEFAULT_VERIFICATION_PAGE_SIZE;
}
