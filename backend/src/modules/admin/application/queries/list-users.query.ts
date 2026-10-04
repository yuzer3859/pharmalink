import { Inject, Injectable } from '@nestjs/common';
import {
  AccountStatus,
  IDENTITY_ADMIN_PORT,
  IIdentityAdminPort,
  PaginatedResult,
  PrimaryRole,
  UserSummaryView,
} from '../../../identity/application/ports/inbound/identity-admin.port';

export const DEFAULT_USER_PAGE = 1;
export const DEFAULT_USER_PAGE_SIZE = 20;
/** Same ceiling as the verification queue — a page is a screen, not an export. */
export const MAX_USER_PAGE_SIZE = 100;

export interface ListUsersInput {
  status?: AccountStatus;
  primaryRole?: PrimaryRole;
  /** Exact phone (E.164) or email, as Module 01's own identifier lookup takes it. */
  identifier?: string;
  page?: number;
  size?: number;
}

/**
 * `GET /admin/users` (module-16 §9.2, F-AD-05) — search across every account Module 01 holds.
 *
 * The rows are Module 01's projections through `IIdentityAdminPort`; this query adds nothing to
 * them. The filters are the three Module 01 can answer — status, primary role, and the exact
 * phone-or-email lookup it already performs for login — and there is no free-text search,
 * because Module 01 exposes none and a substring match over contact details would be a new
 * capability invented here rather than a filter over an existing one.
 *
 * Every `PrimaryRole` and `AccountStatus` Module 01 defines is accepted. The live product is
 * customers, pharmacy owners and drivers, but the list does not encode that: a `DOCTOR` account
 * appears here the day Module 10 creates one.
 */
@Injectable()
export class ListUsersQuery {
  constructor(@Inject(IDENTITY_ADMIN_PORT) private readonly identity: IIdentityAdminPort) {}

  async execute(input: ListUsersInput): Promise<PaginatedResult<UserSummaryView>> {
    const page =
      input.page !== undefined && Number.isFinite(input.page) && input.page > 0
        ? Math.floor(input.page)
        : DEFAULT_USER_PAGE;
    const size =
      input.size !== undefined && Number.isFinite(input.size) && input.size > 0
        ? Math.min(Math.floor(input.size), MAX_USER_PAGE_SIZE)
        : DEFAULT_USER_PAGE_SIZE;

    return this.identity.listUsers(
      { status: input.status, primaryRole: input.primaryRole, identifier: input.identifier },
      page,
      size,
    );
  }
}
