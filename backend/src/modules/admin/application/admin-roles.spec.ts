import { AuditService } from '../../../shared/audit/audit.service';
import { ApiException } from '../../../shared/errors/api-exception';
import { ErrorCode } from '../../../shared/errors/error-codes';
import {
  IIdentityAdminPort,
  RoleChangeResult,
} from '../../identity/application/ports/inbound/identity-admin.port';
import { ADMIN_ROLE_ASSIGNED, AssignRoleCommand } from './commands/assign-role.command';
import { ADMIN_ROLE_REVOKED, RevokeRoleCommand } from './commands/revoke-role.command';
import { GetUserRolesQuery } from './queries/get-user-roles.query';
import { ListRoleCatalogueQuery } from './queries/list-role-catalogue.query';

/**
 * Module 16 Work 04's application layer, with Module 01 behind a fake port. The claims here are
 * about forwarding and recording; which assignments Module 01 accepts is asserted against
 * PostgreSQL in `test/admin/admin-roles.e2e-spec.ts`.
 */
describe('Admin role management (application)', () => {
  const NOW = new Date('2026-09-17T12:00:00.000Z');

  function change(overrides: Partial<RoleChangeResult> = {}): RoleChangeResult {
    return {
      assignmentId: 'asg-2',
      userId: 'user-1',
      roleKey: 'PHARMACY_OWNER',
      organizationId: 'org-1',
      rolesBefore: [{ roleKey: 'CUSTOMER', organizationId: null }],
      rolesAfter: [
        { roleKey: 'CUSTOMER', organizationId: null },
        { roleKey: 'PHARMACY_OWNER', organizationId: 'org-1' },
      ],
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

  describe('ListRoleCatalogueQuery', () => {
    it('returns Module 01 catalogue unchanged', async () => {
      identity.listRoles.mockResolvedValue([
        {
          id: 'r1',
          key: 'ADMIN',
          name: 'Admin',
          scope: 'PLATFORM',
          isSystem: true,
          description: null,
          permissions: ['rbac:read'],
        },
      ]);
      const roles = await new ListRoleCatalogueQuery(identity).execute();
      expect(roles).toHaveLength(1);
      expect(roles[0].key).toBe('ADMIN');
      expect(roles[0].permissions).toEqual(['rbac:read']);
    });
  });

  describe('GetUserRolesQuery', () => {
    it('returns the assignments Module 01 holds', async () => {
      identity.listUserRoles.mockResolvedValue([
        {
          assignmentId: 'asg-1',
          roleKey: 'CUSTOMER',
          roleName: 'Customer',
          organizationId: null,
          assignedBy: null,
          createdAt: NOW,
        },
      ]);
      const roles = await new GetUserRolesQuery(identity).execute('user-1');
      expect(roles.map((r) => r.roleKey)).toEqual(['CUSTOMER']);
    });

    it('answers NOT_FOUND for an unknown user', async () => {
      identity.listUserRoles.mockResolvedValue(null);
      await expect(new GetUserRolesQuery(identity).execute('missing')).rejects.toMatchObject({
        code: ErrorCode.NOT_FOUND,
      });
    });
  });

  describe('AssignRoleCommand', () => {
    let command: AssignRoleCommand;

    beforeEach(() => {
      command = new AssignRoleCommand(identity, audit);
      identity.assignRole.mockResolvedValue(change());
    });

    it('forwards the authenticated actor, the role key and the organization to Module 01', async () => {
      await command.execute({
        actorUserId: 'super-1',
        targetUserId: 'user-1',
        roleKey: 'PHARMACY_OWNER',
        organizationId: 'org-1',
        ip: '10.0.0.1',
      });
      expect(identity.assignRole).toHaveBeenCalledWith({
        targetUserId: 'user-1',
        roleKey: 'PHARMACY_OWNER',
        organizationId: 'org-1',
        actorUserId: 'super-1',
        ip: '10.0.0.1',
      });
    });

    it('records the admin action with the role set before and after', async () => {
      await command.execute({
        actorUserId: 'super-1',
        targetUserId: 'user-1',
        roleKey: 'PHARMACY_OWNER',
        organizationId: 'org-1',
        ip: '10.0.0.1',
      });
      expect(audit.record).toHaveBeenCalledTimes(1);
      const [entry] = audit.record.mock.calls[0];
      expect(entry).toMatchObject({
        actorUserId: 'super-1',
        action: ADMIN_ROLE_ASSIGNED,
        resourceType: 'user',
        resourceId: 'user-1',
        ip: '10.0.0.1',
      });
      expect(entry.context).toEqual({
        targetUserId: 'user-1',
        roleKey: 'PHARMACY_OWNER',
        organizationId: 'org-1',
        assignmentId: 'asg-2',
        rolesBefore: [{ roleKey: 'CUSTOMER', organizationId: null }],
        rolesAfter: [
          { roleKey: 'CUSTOMER', organizationId: null },
          { roleKey: 'PHARMACY_OWNER', organizationId: 'org-1' },
        ],
      });
    });

    it('writes no audit entry when Module 01 refuses', async () => {
      identity.assignRole.mockRejectedValue(
        new ApiException(ErrorCode.CONFLICT, 'This role is already assigned to the user'),
      );
      await expect(
        command.execute({
          actorUserId: 'super-1',
          targetUserId: 'user-1',
          roleKey: 'PHARMACY_OWNER',
          organizationId: 'org-1',
          ip: null,
        }),
      ).rejects.toMatchObject({ code: ErrorCode.CONFLICT });
      expect(audit.record).not.toHaveBeenCalled();
    });
  });

  describe('RevokeRoleCommand', () => {
    let command: RevokeRoleCommand;

    beforeEach(() => {
      command = new RevokeRoleCommand(identity, audit);
      identity.revokeRole.mockResolvedValue(
        change({
          rolesBefore: [
            { roleKey: 'CUSTOMER', organizationId: null },
            { roleKey: 'PHARMACY_OWNER', organizationId: 'org-1' },
          ],
          rolesAfter: [{ roleKey: 'CUSTOMER', organizationId: null }],
        }),
      );
    });

    it('forwards the actor and the assignment id to Module 01', async () => {
      await command.execute({
        actorUserId: 'super-1',
        targetUserId: 'user-1',
        assignmentId: 'asg-2',
        ip: null,
      });
      expect(identity.revokeRole).toHaveBeenCalledWith({
        targetUserId: 'user-1',
        assignmentId: 'asg-2',
        actorUserId: 'super-1',
        ip: null,
      });
    });

    it('records the admin action with what was removed and what remains', async () => {
      await command.execute({
        actorUserId: 'super-1',
        targetUserId: 'user-1',
        assignmentId: 'asg-2',
        ip: '10.0.0.2',
      });
      const [entry] = audit.record.mock.calls[0];
      expect(entry).toMatchObject({
        actorUserId: 'super-1',
        action: ADMIN_ROLE_REVOKED,
        resourceType: 'user',
        resourceId: 'user-1',
      });
      expect(entry.context).toMatchObject({
        roleKey: 'PHARMACY_OWNER',
        organizationId: 'org-1',
        assignmentId: 'asg-2',
        rolesAfter: [{ roleKey: 'CUSTOMER', organizationId: null }],
      });
    });

    it('writes no audit entry when Module 01 refuses', async () => {
      identity.revokeRole.mockRejectedValue(
        new ApiException(ErrorCode.NOT_FOUND, 'Role assignment not found'),
      );
      await expect(
        command.execute({ actorUserId: 'super-1', targetUserId: 'user-1', assignmentId: 'nope', ip: null }),
      ).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
      expect(audit.record).not.toHaveBeenCalled();
    });
  });
});
