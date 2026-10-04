import { AuditService } from '../../../shared/audit/audit.service';
import { ApiException } from '../../../shared/errors/api-exception';
import { ErrorCode } from '../../../shared/errors/error-codes';
import {
  AccountStatus,
  AccountStatusChangeResult,
  IIdentityAdminPort,
  PrimaryRole,
  UserDetailView,
  UserSummaryView,
} from '../../identity/application/ports/inbound/identity-admin.port';
import { PreferredLanguage } from '../../identity/domain/enums';
import { ADMIN_USER_REINSTATED, ReinstateUserCommand } from './commands/reinstate-user.command';
import { ADMIN_USER_SUSPENDED, SuspendUserCommand } from './commands/suspend-user.command';
import { GetUserQuery } from './queries/get-user.query';
import {
  DEFAULT_USER_PAGE_SIZE,
  ListUsersQuery,
  MAX_USER_PAGE_SIZE,
} from './queries/list-users.query';

/**
 * Module 16 Work 03's application layer, with Module 01 behind a fake port.
 *
 * As with Work 02, the claims here are about what this module sends and records: the actor
 * forwarded to Module 01 is the authenticated principal, the filters forwarded are the ones
 * Module 01 answers, an audit entry is written for a change Module 01 accepted and not for one
 * it refused. Which transitions Module 01 accepts is Module 01's claim, made against PostgreSQL
 * in `test/admin/admin-accounts.e2e-spec.ts`.
 */
describe('Admin user & account management (application)', () => {
  const NOW = new Date('2026-09-17T12:00:00.000Z');

  function summary(overrides: Partial<UserSummaryView> = {}): UserSummaryView {
    return {
      userId: 'user-1',
      phone: '+251911000000',
      email: null,
      primaryRole: PrimaryRole.DRIVER,
      status: AccountStatus.ACTIVE,
      createdAt: new Date('2026-09-01T00:00:00.000Z'),
      updatedAt: new Date('2026-09-01T00:00:00.000Z'),
      ...overrides,
    };
  }

  function detail(overrides: Partial<UserDetailView> = {}): UserDetailView {
    return {
      ...summary(),
      preferredLanguage: PreferredLanguage.am,
      phoneVerifiedAt: new Date('2026-09-01T00:00:00.000Z'),
      emailVerifiedAt: null,
      faydaVerifiedAt: null,
      deletionRequestedAt: null,
      deletedAt: null,
      roles: [
        {
          assignmentId: 'asg-1',
          roleKey: 'DRIVER',
          roleName: 'Driver',
          organizationId: null,
          assignedBy: null,
          createdAt: NOW,
        },
      ],
      ...overrides,
    };
  }

  function change(overrides: Partial<AccountStatusChangeResult> = {}): AccountStatusChangeResult {
    return {
      userId: 'user-1',
      previousStatus: AccountStatus.ACTIVE,
      status: AccountStatus.SUSPENDED,
      changedAt: NOW,
      ...overrides,
    };
  }

  let identity: jest.Mocked<IIdentityAdminPort>;
  let audit: jest.Mocked<AuditService>;

  beforeEach(() => {
    identity = {
      listUsers: jest.fn(),
      getUser: jest.fn(),
      suspendUser: jest.fn(),
      reactivateUser: jest.fn(),
      listRoles: jest.fn(),
      listUserRoles: jest.fn(),
      assignRole: jest.fn(),
      revokeRole: jest.fn(),
      listVerificationRequests: jest.fn(),
      getVerificationRequest: jest.fn(),
      approveVerification: jest.fn(),
      rejectVerification: jest.fn(),
    };
    audit = {
      record: jest.fn().mockResolvedValue({ id: 'audit-1', hash: 'h' }),
    } as unknown as jest.Mocked<AuditService>;
  });

  // -------------------------------------------------------------------------------------------
  // 1. List
  // -------------------------------------------------------------------------------------------

  describe('ListUsersQuery', () => {
    let query: ListUsersQuery;

    beforeEach(() => {
      query = new ListUsersQuery(identity);
      identity.listUsers.mockResolvedValue({
        items: [summary()],
        total: 1,
        page: 1,
        size: DEFAULT_USER_PAGE_SIZE,
      });
    });

    it('forwards the three filters Module 01 answers and nothing else', async () => {
      await query.execute({
        status: AccountStatus.SUSPENDED,
        primaryRole: PrimaryRole.PHARMACY_OWNER,
        identifier: 'owner@example.com',
      });
      expect(identity.listUsers).toHaveBeenCalledWith(
        {
          status: AccountStatus.SUSPENDED,
          primaryRole: PrimaryRole.PHARMACY_OWNER,
          identifier: 'owner@example.com',
        },
        1,
        DEFAULT_USER_PAGE_SIZE,
      );
    });

    it('applies no filter by default', async () => {
      await query.execute({});
      const [filter] = identity.listUsers.mock.calls[0];
      expect(filter).toEqual({ status: undefined, primaryRole: undefined, identifier: undefined });
    });

    it('clamps the page size to the ceiling and floors a fractional page', async () => {
      await query.execute({ page: 3.9, size: 10_000 });
      expect(identity.listUsers).toHaveBeenCalledWith(expect.anything(), 3, MAX_USER_PAGE_SIZE);
    });

    it('falls back to defaults for a non-positive page or size', async () => {
      await query.execute({ page: -1, size: 0 });
      expect(identity.listUsers).toHaveBeenCalledWith(expect.anything(), 1, DEFAULT_USER_PAGE_SIZE);
    });

    it('returns Module 01 page unchanged', async () => {
      const result = await query.execute({});
      expect(result.total).toBe(1);
      expect(result.items[0].userId).toBe('user-1');
      expect(Object.keys(result.items[0])).not.toContain('passwordHash');
    });
  });

  // -------------------------------------------------------------------------------------------
  // 2. Detail
  // -------------------------------------------------------------------------------------------

  describe('GetUserQuery', () => {
    let query: GetUserQuery;

    beforeEach(() => {
      query = new GetUserQuery(identity);
    });

    it('returns Module 01 projection', async () => {
      identity.getUser.mockResolvedValue(detail());
      const view = await query.execute('user-1');
      expect(view.roles).toHaveLength(1);
      expect(view.preferredLanguage).toBe(PreferredLanguage.am);
      const keys = Object.keys(view);
      expect(keys).not.toContain('passwordHash');
      expect(keys).not.toContain('permVersion');
    });

    it('answers NOT_FOUND for an id Module 01 does not know', async () => {
      identity.getUser.mockResolvedValue(null);
      await expect(query.execute('missing')).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
    });
  });

  // -------------------------------------------------------------------------------------------
  // 3. Suspend
  // -------------------------------------------------------------------------------------------

  describe('SuspendUserCommand', () => {
    let command: SuspendUserCommand;

    beforeEach(() => {
      command = new SuspendUserCommand(identity, audit);
      identity.suspendUser.mockResolvedValue(change());
    });

    it('forwards the authenticated actor and the reason to Module 01', async () => {
      await command.execute({
        actorUserId: 'admin-1',
        targetUserId: 'user-1',
        reason: 'Fraudulent orders',
        ip: '10.0.0.1',
      });
      expect(identity.suspendUser).toHaveBeenCalledWith({
        targetUserId: 'user-1',
        actorUserId: 'admin-1',
        reason: 'Fraudulent orders',
        ip: '10.0.0.1',
      });
    });

    it('records the admin action with the transition and the reason', async () => {
      await command.execute({
        actorUserId: 'admin-1',
        targetUserId: 'user-1',
        reason: 'Fraudulent orders',
        ip: '10.0.0.1',
      });
      expect(audit.record).toHaveBeenCalledTimes(1);
      const [entry] = audit.record.mock.calls[0];
      expect(entry).toMatchObject({
        actorUserId: 'admin-1',
        action: ADMIN_USER_SUSPENDED,
        resourceType: 'user',
        resourceId: 'user-1',
        ip: '10.0.0.1',
      });
      expect(entry.context).toEqual({
        targetUserId: 'user-1',
        previousStatus: AccountStatus.ACTIVE,
        status: AccountStatus.SUSPENDED,
        reason: 'Fraudulent orders',
        changedAt: NOW.toISOString(),
      });
    });

    it('reports Module 01 idempotent no-op as an unchanged transition, and still records it', async () => {
      identity.suspendUser.mockResolvedValue(
        change({ previousStatus: AccountStatus.SUSPENDED, status: AccountStatus.SUSPENDED }),
      );
      const result = await command.execute({
        actorUserId: 'admin-1',
        targetUserId: 'user-1',
        reason: 'Fraudulent orders',
        ip: null,
      });
      expect(result.previousStatus).toBe(AccountStatus.SUSPENDED);
      expect(result.status).toBe(AccountStatus.SUSPENDED);
      expect(audit.record).toHaveBeenCalledTimes(1);
    });

    it('writes no audit entry when Module 01 refuses', async () => {
      identity.suspendUser.mockRejectedValue(
        new ApiException(ErrorCode.BUSINESS_RULE_VIOLATION, 'You cannot suspend your own account.'),
      );
      await expect(
        command.execute({ actorUserId: 'admin-1', targetUserId: 'admin-1', reason: 'oops', ip: null }),
      ).rejects.toMatchObject({ code: ErrorCode.BUSINESS_RULE_VIOLATION });
      expect(audit.record).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------------------------
  // 4. Reinstate
  // -------------------------------------------------------------------------------------------

  describe('ReinstateUserCommand', () => {
    let command: ReinstateUserCommand;

    beforeEach(() => {
      command = new ReinstateUserCommand(identity, audit);
      identity.reactivateUser.mockResolvedValue(
        change({ previousStatus: AccountStatus.SUSPENDED, status: AccountStatus.ACTIVE }),
      );
    });

    it('forwards the authenticated actor to Module 01 reactivation', async () => {
      await command.execute({ actorUserId: 'admin-2', targetUserId: 'user-1', reason: null, ip: null });
      expect(identity.reactivateUser).toHaveBeenCalledWith({
        targetUserId: 'user-1',
        actorUserId: 'admin-2',
        ip: null,
      });
    });

    it('records the admin action with the SUSPENDED -> ACTIVE transition', async () => {
      await command.execute({
        actorUserId: 'admin-2',
        targetUserId: 'user-1',
        reason: 'Appeal upheld',
        ip: '10.0.0.2',
      });
      const [entry] = audit.record.mock.calls[0];
      expect(entry).toMatchObject({
        actorUserId: 'admin-2',
        action: ADMIN_USER_REINSTATED,
        resourceType: 'user',
        resourceId: 'user-1',
      });
      expect(entry.context).toMatchObject({
        previousStatus: AccountStatus.SUSPENDED,
        status: AccountStatus.ACTIVE,
        reason: 'Appeal upheld',
      });
    });

    it('writes no audit entry when Module 01 refuses the transition', async () => {
      identity.reactivateUser.mockRejectedValue(
        new ApiException(ErrorCode.BUSINESS_RULE_VIOLATION, 'ACTIVE cannot be moved to ACTIVE'),
      );
      await expect(
        command.execute({ actorUserId: 'admin-2', targetUserId: 'user-1', reason: null, ip: null }),
      ).rejects.toMatchObject({ code: ErrorCode.BUSINESS_RULE_VIOLATION });
      expect(audit.record).not.toHaveBeenCalled();
    });
  });
});
