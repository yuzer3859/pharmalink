import { AccountStatus, PrimaryRole } from '../../../domain/enums';

export const IDENTITY_ANALYTICS_READ_PORT = Symbol('IDENTITY_ANALYTICS_READ_PORT');

/** Re-exported so a consumer depends on this one file and not on Module 01's domain layer. */
export { AccountStatus, PrimaryRole } from '../../../domain/enums';

export interface AccountStatusCount {
  status: AccountStatus;
  count: number;
}

export interface PrimaryRoleCount {
  primaryRole: PrimaryRole;
  count: number;
}

/**
 * Every `users` row, counted — the population `IUserRepository.search` pages over, and
 * therefore the one an administrator's account list shows. Nothing is excluded: a `DELETED` or
 * `DEACTIVATED` account is a status bucket, not a missing row, so `total` is Σ `byStatus` and
 * also Σ `byPrimaryRole`.
 *
 * Both breakdowns carry **every** enum value, in declaration order, with `0` for the empty
 * ones — the response shape does not depend on the data.
 */
export interface AccountAnalyticsView {
  total: number;
  byStatus: AccountStatusCount[];
  byPrimaryRole: PrimaryRoleCount[];
}

/**
 * Module 01's exported contract for **read-only account analytics**, consumed in-process by
 * Module 16 (module-16 Work 08). One read, no filter, no row: the counts are the database's
 * `COUNT`/`GROUP BY` over persisted columns, and no identifier, contact detail or credential
 * crosses this seam.
 *
 * Kept apart from `IIdentityAdminPort`, which reads and acts on individual accounts under
 * `rbac:read`/`user:*` authority; a dashboard that only needs the counts should not be handed the
 * accounts.
 */
export interface IIdentityAnalyticsReadPort {
  summarizeAccounts(): Promise<AccountAnalyticsView>;
}
