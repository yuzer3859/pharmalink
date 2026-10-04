import { Inject, Injectable } from '@nestjs/common';
import { ApiException } from '../../../../../shared/errors/api-exception';
import { User } from '../../../domain/entities/user.entity';
import { VerificationRequest } from '../../../domain/entities/verification-request.entity';
import {
  AccountStatus,
  PreferredLanguage,
  PrimaryRole,
  VerificationStatus,
  VerificationType,
} from '../../../domain/enums';
import { PaginatedResult } from '../../../domain/repositories/auth.repositories';
import {
  IUserRepository,
  USER_REPOSITORY,
  UserSearchFilter,
} from '../../../domain/repositories/user.repository';
import {
  IVerificationRepository,
  VERIFICATION_REPOSITORY,
  VerificationSearchFilter,
} from '../../../domain/repositories/verification.repository';
import { IRbacRepository, RBAC_REPOSITORY } from '../../../domain/repositories/rbac.repository';
import { ApproveVerificationCommand } from '../../commands/approve-verification.command';
import { AssignUserRoleCommand } from '../../commands/assign-user-role.command';
import { ReactivateUserCommand } from '../../commands/reactivate-user.command';
import { RejectVerificationCommand } from '../../commands/reject-verification.command';
import { RevokeUserRoleCommand } from '../../commands/revoke-user-role.command';
import { SuspendUserCommand } from '../../commands/suspend-user.command';
import { ListRolesQuery } from '../../queries/list-roles.query';
import { ListUserRolesQuery } from '../../queries/list-user-roles.query';

export const IDENTITY_ADMIN_PORT = Symbol('IDENTITY_ADMIN_PORT');

/**
 * Re-exported so a consumer of this port depends on this one file and not on Module 01's domain
 * layer. These are the states and types Module 01 defines; the consumer may name them, never add
 * to them.
 */
export { AccountStatus, PrimaryRole, VerificationStatus, VerificationType } from '../../../domain/enums';
export type { VerificationSearchFilter } from '../../../domain/repositories/verification.repository';
export type { UserSearchFilter } from '../../../domain/repositories/user.repository';
export type { PaginatedResult } from '../../../domain/repositories/auth.repositories';

/**
 * One row of the admin user list. Contact details are here because they are how an
 * administrator identifies an account; nothing that authenticates one is — no password hash, no
 * permission version, no token. Module 01 holds no name (that is Module 02's profile).
 */
export interface UserSummaryView {
  userId: string;
  phone: string | null;
  email: string | null;
  primaryRole: PrimaryRole;
  status: AccountStatus;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * A role assignment as Module 01's own `GET /admin/users/:id/roles` reports it. `assignmentId`
 * is the handle a revocation takes — one role can be held several times under different
 * organizations, so the role key alone does not name an assignment.
 */
export interface UserRoleAssignmentView {
  assignmentId: string;
  roleKey: string;
  roleName: string;
  organizationId: string | null;
  assignedBy: string | null;
  createdAt: Date;
}

/** A role from the catalogue as Module 01's own `GET /admin/rbac/roles` reports it. */
export interface RoleCatalogueView {
  id: string;
  key: string;
  name: string;
  scope: string;
  isSystem: boolean;
  description: string | null;
  permissions: string[];
}

/** The role set an account holds, as a comparable snapshot for an audit entry. */
export interface RoleHolding {
  roleKey: string;
  organizationId: string | null;
}

export interface RoleChangeResult {
  assignmentId: string;
  userId: string;
  roleKey: string;
  organizationId: string | null;
  rolesBefore: RoleHolding[];
  rolesAfter: RoleHolding[];
}

export interface AssignRoleRequestInput {
  targetUserId: string;
  roleKey: string;
  organizationId: string | null;
  actorUserId: string;
  ip: string | null;
}

export interface RevokeRoleRequestInput {
  targetUserId: string;
  assignmentId: string;
  actorUserId: string;
  ip: string | null;
}

/**
 * Everything an administrator may see about one account. Verification is reported as
 * timestamps (`faydaVerifiedAt` says that the check passed, never what number was checked);
 * organization association is the role assignments Module 01 already lists.
 */
export interface UserDetailView extends UserSummaryView {
  preferredLanguage: PreferredLanguage;
  phoneVerifiedAt: Date | null;
  emailVerifiedAt: Date | null;
  faydaVerifiedAt: Date | null;
  deletionRequestedAt: Date | null;
  deletedAt: Date | null;
  roles: UserRoleAssignmentView[];
}

export interface AccountStatusChangeResult {
  userId: string;
  previousStatus: AccountStatus;
  status: AccountStatus;
  changedAt: Date;
}

export interface SuspendUserRequestInput {
  targetUserId: string;
  actorUserId: string;
  reason: string;
  ip: string | null;
}

export interface ReactivateUserRequestInput {
  targetUserId: string;
  actorUserId: string;
  ip: string | null;
}

/** One row of the admin verification queue. Never carries the Fayda number or document refs. */
export interface VerificationSummaryView {
  requestId: string;
  userId: string;
  organizationId: string | null;
  type: VerificationType;
  status: VerificationStatus;
  documentCount: number;
  submittedAt: Date;
  reviewedAt: Date | null;
}

/** A document reference as Module 01 stores it — the opaque `storageRef`, never bytes. */
export interface VerificationDocumentView {
  kind: string;
  storageRef: string;
  expiresAt: string | null;
}

/**
 * Everything an administrator reviewing one request may see. `hasFaydaId` says whether a
 * national-ID check is attached; the identifier itself is not exposed to anyone (§9.4).
 */
export interface VerificationDetailView extends VerificationSummaryView {
  documents: VerificationDocumentView[];
  hasFaydaId: boolean;
  reviewerId: string | null;
  rejectReason: string | null;
  expiresAt: Date | null;
  /** The subject's account as Module 01 sees it — what a decision would lift or hold. */
  applicant: { userId: string; primaryRole: PrimaryRole; accountStatus: AccountStatus } | null;
}

export interface VerificationDecisionResult {
  requestId: string;
  type: VerificationType;
  previousStatus: VerificationStatus;
  status: VerificationStatus;
  subjectUserId: string;
  organizationId: string | null;
  reviewedAt: Date | null;
  expiresAt: Date | null;
}

export interface ApproveVerificationRequestInput {
  requestId: string;
  reviewerId: string;
  expiresAt: Date | null;
  ip: string | null;
}

export interface RejectVerificationRequestInput {
  requestId: string;
  reviewerId: string;
  reason: string;
  ip: string | null;
}

/**
 * Module 01's exported contract for **verification administration**, consumed in-process by
 * Module 16 via Nest DI — the inbound-port shape Module 07 exports as `IPaymentAuthorizationPort`
 * and Module 08 as `IDeliveryPricingPort` (ADR-002).
 *
 * ## Why this port exists
 *
 * Module 16's design makes Admin "orchestration, not ownership": its verification queue must read
 * and decide requests that Module 01 owns, without touching `verification_requests` or `users`
 * and without importing a repository across the boundary. `IdentityModule` exported nothing an
 * admin surface could use — `TOKEN_SERVICE` and `PERM_VERSION_STORE` authenticate, they do not
 * review — so this is the missing contract, and it is deliberately the smallest one that closes
 * the gap: list, read, approve, reject (Work 02); for accounts, list, read, suspend,
 * reactivate (Work 03); for roles, list the catalogue, list a user's assignments, assign, revoke
 * (Work 04) — every one an operation Module 01's own admin controllers already perform, exposed
 * as a contract rather than re-implemented.
 *
 * ## What it does not do
 *
 *  - It does not decide anything itself. `approve`/`reject` delegate 1:1 to the already-tested
 *    `ApproveVerificationCommand` / `RejectVerificationCommand`, so the separation-of-duties
 *    rule, the PENDING-only guard, the account-status lift, the `identity.provider.*` events and
 *    Module 01's own audit entry all happen exactly as they do for Module 01's own controller.
 *    There is one state machine and it is the aggregate's.
 *  - It has no "request additional documents" operation, because Module 01 has none: the only
 *    document mutation is the applicant's own `attachDocuments` while the request is open.
 *    Adding one here would be inventing a verification state Module 01 does not define.
 *  - It returns projections, not aggregates, and the projections never include
 *    `faydaIdEncrypted`. A consumer of this port cannot obtain the identifier by any call.
 */
export interface IIdentityAdminPort {
  // --- Accounts (Work 03) -----------------------------------------------------------------

  listUsers(
    filter: UserSearchFilter,
    page: number,
    size: number,
  ): Promise<PaginatedResult<UserSummaryView>>;

  getUser(userId: string): Promise<UserDetailView | null>;

  /**
   * Delegates to `SuspendUserCommand`: same self-suspension refusal, same terminal-state rule,
   * same idempotent no-op on an already-suspended account, same credential revocation, same
   * `identity.account.suspended` event and Module 01 audit entry. The result reports the
   * transition — `previousStatus === status` when Module 01 treated it as a no-op.
   */
  suspendUser(input: SuspendUserRequestInput): Promise<AccountStatusChangeResult>;

  /** Delegates to `ReactivateUserCommand`: only `SUSPENDED -> ACTIVE`; anything else is refused. */
  reactivateUser(input: ReactivateUserRequestInput): Promise<AccountStatusChangeResult>;

  // --- Roles (Work 04) -------------------------------------------------------------------

  /** The role catalogue, read-only. Module 01 seeds it; nobody creates roles through a port. */
  listRoles(): Promise<RoleCatalogueView[]>;

  /** `null` when the user does not exist — the caller answers as it answers any unknown user. */
  listUserRoles(userId: string): Promise<UserRoleAssignmentView[] | null>;

  /**
   * Delegates to `AssignUserRoleCommand`: same role-scope contract (an ORG role needs an existing
   * organization, any other role refuses one), same duplicate refusal, same permVersion bump and
   * Module 01 audit entry. Module 01 has no rule about *which* roles may be granted to whom, and
   * none is added here — see `AdminAccountsController` for what that means.
   */
  assignRole(input: AssignRoleRequestInput): Promise<RoleChangeResult>;

  /** Delegates to `RevokeUserRoleCommand`: the assignment must belong to the named user. */
  revokeRole(input: RevokeRoleRequestInput): Promise<RoleChangeResult>;

  // --- Verification (Work 02) ------------------------------------------------------------

  listVerificationRequests(
    filter: VerificationSearchFilter,
    page: number,
    size: number,
  ): Promise<PaginatedResult<VerificationSummaryView>>;

  getVerificationRequest(requestId: string): Promise<VerificationDetailView | null>;

  /** Delegates to `ApproveVerificationCommand`; Module 01's errors propagate unchanged. */
  approveVerification(input: ApproveVerificationRequestInput): Promise<VerificationDecisionResult>;

  /** Delegates to `RejectVerificationCommand`; Module 01's errors propagate unchanged. */
  rejectVerification(input: RejectVerificationRequestInput): Promise<VerificationDecisionResult>;
}

/**
 * Implements `IIdentityAdminPort` as a facade over Module 01's own commands and repositories.
 * Owns no decision logic: the reads are projections, the writes are unmodified delegation.
 */
@Injectable()
export class IdentityAdminPortAdapter implements IIdentityAdminPort {
  constructor(
    @Inject(VERIFICATION_REPOSITORY) private readonly verifications: IVerificationRepository,
    @Inject(USER_REPOSITORY) private readonly users: IUserRepository,
    private readonly approve: ApproveVerificationCommand,
    private readonly reject: RejectVerificationCommand,
    private readonly suspend: SuspendUserCommand,
    private readonly reactivate: ReactivateUserCommand,
    private readonly userRoles: ListUserRolesQuery,
    private readonly roles: ListRolesQuery,
    private readonly assign: AssignUserRoleCommand,
    private readonly revoke: RevokeUserRoleCommand,
    @Inject(RBAC_REPOSITORY) private readonly rbac: IRbacRepository,
  ) {}

  async listRoles(): Promise<RoleCatalogueView[]> {
    return this.roles.execute();
  }

  async listUserRoles(userId: string): Promise<UserRoleAssignmentView[] | null> {
    const user = await this.users.findById(userId);
    if (!user) {
      return null;
    }
    return (await this.userRoles.execute(userId)).map(toAssignmentView);
  }

  async assignRole(input: AssignRoleRequestInput): Promise<RoleChangeResult> {
    const rolesBefore = await this.holdings(input.targetUserId);
    const result = await this.assign.execute(input);
    return {
      assignmentId: result.assignmentId,
      userId: result.userId,
      roleKey: result.roleKey,
      organizationId: result.organizationId,
      rolesBefore,
      rolesAfter: await this.holdings(input.targetUserId),
    };
  }

  async revokeRole(input: RevokeRoleRequestInput): Promise<RoleChangeResult> {
    // Read before the delete: the command answers nothing about what it removed, and the
    // assignment is gone afterwards. The command re-checks the user match itself.
    const assignment = await this.rbac.findAssignmentById(input.assignmentId);
    if (!assignment || assignment.userId !== input.targetUserId) {
      throw ApiException.notFound('Role assignment not found');
    }
    const rolesBefore = await this.holdings(input.targetUserId);
    await this.revoke.execute(input);
    return {
      assignmentId: assignment.id,
      userId: assignment.userId,
      roleKey: assignment.roleKey,
      organizationId: assignment.organizationId,
      rolesBefore,
      rolesAfter: await this.holdings(input.targetUserId),
    };
  }

  /** The user's role set as `{roleKey, organizationId}` pairs, for before/after snapshots. */
  private async holdings(userId: string): Promise<RoleHolding[]> {
    const assignments = await this.rbac.listAssignmentsForUser(userId);
    return assignments.map((a) => ({ roleKey: a.roleKey, organizationId: a.organizationId }));
  }

  async listUsers(
    filter: UserSearchFilter,
    page: number,
    size: number,
  ): Promise<PaginatedResult<UserSummaryView>> {
    const result = await this.users.search(filter, page, size);
    return { ...result, items: result.items.map(toUserSummary) };
  }

  async getUser(userId: string): Promise<UserDetailView | null> {
    const user = await this.users.findById(userId);
    if (!user) {
      return null;
    }
    const roles = await this.userRoles.execute(userId);
    const props = user.toProps();
    return {
      ...toUserSummary(user),
      preferredLanguage: props.preferredLanguage,
      phoneVerifiedAt: props.phoneVerifiedAt,
      emailVerifiedAt: props.emailVerifiedAt,
      faydaVerifiedAt: props.faydaVerifiedAt,
      deletionRequestedAt: props.deletionRequestedAt,
      deletedAt: props.deletedAt,
      roles: roles.map(toAssignmentView),
    };
  }

  async suspendUser(input: SuspendUserRequestInput): Promise<AccountStatusChangeResult> {
    const previousStatus = await this.statusOf(input.targetUserId);
    await this.suspend.execute(input);
    return this.statusChanged(input.targetUserId, previousStatus);
  }

  async reactivateUser(input: ReactivateUserRequestInput): Promise<AccountStatusChangeResult> {
    const previousStatus = await this.statusOf(input.targetUserId);
    await this.reactivate.execute(input);
    return this.statusChanged(input.targetUserId, previousStatus);
  }

  /** The status a lifecycle command will act on. Not found answers as the command itself would. */
  private async statusOf(userId: string): Promise<AccountStatus> {
    const user = await this.users.findById(userId);
    if (!user) {
      throw ApiException.notFound('User not found');
    }
    return user.status;
  }

  private async statusChanged(
    userId: string,
    previousStatus: AccountStatus,
  ): Promise<AccountStatusChangeResult> {
    const user = await this.users.findById(userId);
    if (!user) {
      throw new Error(`User ${userId} vanished after its status change`);
    }
    const props = user.toProps();
    return { userId, previousStatus, status: props.status, changedAt: props.updatedAt };
  }

  async listVerificationRequests(
    filter: VerificationSearchFilter,
    page: number,
    size: number,
  ): Promise<PaginatedResult<VerificationSummaryView>> {
    const result = await this.verifications.search(filter, page, size);
    return { ...result, items: result.items.map(toSummary) };
  }

  async getVerificationRequest(requestId: string): Promise<VerificationDetailView | null> {
    const request = await this.verifications.findById(requestId);
    if (!request) {
      return null;
    }
    const user = await this.users.findById(request.userId);
    const props = request.toProps();
    return {
      ...toSummary(request),
      documents: request.documents.map((d) => ({
        kind: d.kind,
        storageRef: d.storageRef,
        expiresAt: d.expiresAt ?? null,
      })),
      hasFaydaId: props.faydaIdEncrypted !== null,
      reviewerId: request.reviewerId,
      rejectReason: request.rejectReason,
      expiresAt: request.expiresAt,
      applicant: user
        ? { userId: user.id, primaryRole: user.primaryRole, accountStatus: user.status }
        : null,
    };
  }

  async approveVerification(
    input: ApproveVerificationRequestInput,
  ): Promise<VerificationDecisionResult> {
    await this.approve.execute(input);
    return this.decided(input.requestId);
  }

  async rejectVerification(
    input: RejectVerificationRequestInput,
  ): Promise<VerificationDecisionResult> {
    await this.reject.execute(input);
    return this.decided(input.requestId);
  }

  /**
   * The request as stored after a successful decision. `previousStatus` is `PENDING` by
   * construction — the aggregate reviews nothing else, and the command has just succeeded.
   */
  private async decided(requestId: string): Promise<VerificationDecisionResult> {
    const request = await this.verifications.findById(requestId);
    if (!request) {
      // The command found and decided it a moment ago; only a concurrent hard delete gets here.
      throw new Error(`Verification request ${requestId} vanished after its decision`);
    }
    return {
      requestId: request.id,
      type: request.type,
      previousStatus: VerificationStatus.PENDING,
      status: request.status,
      subjectUserId: request.userId,
      organizationId: request.organizationId,
      reviewedAt: request.reviewedAt,
      expiresAt: request.expiresAt,
    };
  }
}

function toAssignmentView(r: {
  assignmentId: string;
  roleKey: string;
  roleName: string;
  organizationId: string | null;
  assignedBy: string | null;
  createdAt: Date;
}): UserRoleAssignmentView {
  return {
    assignmentId: r.assignmentId,
    roleKey: r.roleKey,
    roleName: r.roleName,
    organizationId: r.organizationId,
    assignedBy: r.assignedBy,
    createdAt: r.createdAt,
  };
}

function toUserSummary(user: User): UserSummaryView {
  const props = user.toProps();
  return {
    userId: props.id,
    phone: props.phone,
    email: props.email,
    primaryRole: props.primaryRole,
    status: props.status,
    createdAt: props.createdAt,
    updatedAt: props.updatedAt,
  };
}

function toSummary(request: VerificationRequest): VerificationSummaryView {
  return {
    requestId: request.id,
    userId: request.userId,
    organizationId: request.organizationId,
    type: request.type,
    status: request.status,
    documentCount: request.documents.length,
    submittedAt: request.submittedAt,
    reviewedAt: request.reviewedAt,
  };
}
