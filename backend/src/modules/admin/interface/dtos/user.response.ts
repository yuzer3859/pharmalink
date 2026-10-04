import {
  AccountStatusChangeResult,
  PaginatedResult,
  UserDetailView,
  UserSummaryView,
} from '../../../identity/application/ports/inbound/identity-admin.port';

/**
 * One account as the admin API reports it. An explicit allow-list: what is absent is
 * `passwordHash`, `permVersion`, `guardianId`, and any token or verification identifier — none
 * of which reach this module in the first place, since the port's projection omits them.
 */
export interface UserSummaryResponse {
  userId: string;
  phone: string | null;
  email: string | null;
  primaryRole: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface UserListResponse {
  items: UserSummaryResponse[];
  total: number;
  page: number;
  size: number;
}

export interface UserRoleAssignmentResponse {
  /** The handle `DELETE /admin/accounts/:id/roles/:assignmentId` takes. */
  assignmentId: string;
  roleKey: string;
  roleName: string;
  organizationId: string | null;
  createdAt: string;
}

export interface UserDetailResponse extends UserSummaryResponse {
  preferredLanguage: string;
  phoneVerifiedAt: string | null;
  emailVerifiedAt: string | null;
  /** That the national-ID check passed, and when. Never the identifier. */
  faydaVerifiedAt: string | null;
  deletionRequestedAt: string | null;
  deletedAt: string | null;
  roles: UserRoleAssignmentResponse[];
}

export interface AccountStatusChangeResponse {
  userId: string;
  previousStatus: string;
  status: string;
  changedAt: string;
}

export function toUserSummaryResponse(user: UserSummaryView): UserSummaryResponse {
  return {
    userId: user.userId,
    phone: user.phone,
    email: user.email,
    primaryRole: user.primaryRole,
    status: user.status,
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString(),
  };
}

export function toUserListResponse(result: PaginatedResult<UserSummaryView>): UserListResponse {
  return {
    items: result.items.map(toUserSummaryResponse),
    total: result.total,
    page: result.page,
    size: result.size,
  };
}

export function toUserDetailResponse(user: UserDetailView): UserDetailResponse {
  return {
    ...toUserSummaryResponse(user),
    preferredLanguage: user.preferredLanguage,
    phoneVerifiedAt: user.phoneVerifiedAt?.toISOString() ?? null,
    emailVerifiedAt: user.emailVerifiedAt?.toISOString() ?? null,
    faydaVerifiedAt: user.faydaVerifiedAt?.toISOString() ?? null,
    deletionRequestedAt: user.deletionRequestedAt?.toISOString() ?? null,
    deletedAt: user.deletedAt?.toISOString() ?? null,
    roles: user.roles.map((r) => ({
      assignmentId: r.assignmentId,
      roleKey: r.roleKey,
      roleName: r.roleName,
      organizationId: r.organizationId,
      createdAt: r.createdAt.toISOString(),
    })),
  };
}

export function toAccountStatusChangeResponse(
  change: AccountStatusChangeResult,
): AccountStatusChangeResponse {
  return {
    userId: change.userId,
    previousStatus: change.previousStatus,
    status: change.status,
    changedAt: change.changedAt.toISOString(),
  };
}
