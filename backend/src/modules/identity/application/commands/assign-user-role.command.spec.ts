import { AuditService } from '../../../../shared/audit/audit.service';
import { ErrorCode } from '../../../../shared/errors/error-codes';
import { User } from '../../domain/entities/user.entity';
import { AccountStatus, PreferredLanguage, PrimaryRole } from '../../domain/enums';
import { IRbacRepository, RoleRecord, UserRoleRecord } from '../../domain/repositories/rbac.repository';
import { IUserRepository } from '../../domain/repositories/user.repository';
import { PermissionChangeService } from '../services/permission-change.service';
import { AssignUserRoleCommand } from './assign-user-role.command';

function fakeUser(): User {
  return User.rehydrate({
    id: 'user-1',
    phone: '+251911000000',
    email: null,
    passwordHash: 'hash',
    primaryRole: PrimaryRole.CUSTOMER,
    status: AccountStatus.ACTIVE,
    preferredLanguage: PreferredLanguage.en,
    phoneVerifiedAt: new Date(),
    emailVerifiedAt: null,
    faydaVerifiedAt: null,
    guardianId: null,
    permVersion: 1,
    deletionRequestedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
  });
}

function role(overrides: Partial<RoleRecord> = {}): RoleRecord {
  return {
    id: 'role-1',
    key: 'PHARMACIST',
    name: 'Pharmacist',
    scope: 'ORG',
    isSystem: true,
    description: null,
    ...overrides,
  };
}

const assignment: UserRoleRecord = {
  id: 'assignment-1',
  userId: 'user-1',
  roleId: 'role-1',
  roleKey: 'PHARMACIST',
  roleName: 'Pharmacist',
  organizationId: 'org-1',
  assignedBy: 'admin-1',
  createdAt: new Date(),
};

describe('AssignUserRoleCommand', () => {
  let rbac: jest.Mocked<IRbacRepository>;
  let users: jest.Mocked<IUserRepository>;
  let permissionChange: jest.Mocked<PermissionChangeService>;
  let audit: jest.Mocked<AuditService>;
  let command: AssignUserRoleCommand;

  beforeEach(() => {
    rbac = {
      findRoleByKey: jest.fn().mockResolvedValue(role()),
      organizationExists: jest.fn().mockResolvedValue(true),
      findAssignment: jest.fn().mockResolvedValue(null),
      createAssignment: jest.fn().mockResolvedValue(assignment),
    } as unknown as jest.Mocked<IRbacRepository>;
    users = { findById: jest.fn().mockResolvedValue(fakeUser()) } as unknown as jest.Mocked<IUserRepository>;
    permissionChange = { propagate: jest.fn().mockResolvedValue(undefined) } as unknown as jest.Mocked<PermissionChangeService>;
    audit = { record: jest.fn().mockResolvedValue({ id: 'a', hash: 'h' }) } as unknown as jest.Mocked<AuditService>;
    command = new AssignUserRoleCommand(rbac, users, permissionChange, audit);
  });

  it('assigns an org-scoped role and propagates the permission change', async () => {
    const result = await command.execute({
      targetUserId: 'user-1',
      roleKey: 'PHARMACIST',
      organizationId: 'org-1',
      actorUserId: 'admin-1',
    });

    expect(rbac.createAssignment).toHaveBeenCalledWith({
      userId: 'user-1',
      roleId: 'role-1',
      organizationId: 'org-1',
      assignedBy: 'admin-1',
    });
    expect(permissionChange.propagate).toHaveBeenCalledWith(['user-1']);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'rbac.user_role.assigned', resourceId: 'user-1' }),
    );
    expect(result.assignmentId).toBe('assignment-1');
  });

  it('requires an organization for ORG-scoped roles', async () => {
    await expect(
      command.execute({ targetUserId: 'user-1', roleKey: 'PHARMACIST', actorUserId: 'admin-1' }),
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_ERROR });
    expect(rbac.createAssignment).not.toHaveBeenCalled();
  });

  it('rejects an organization for platform-scoped roles', async () => {
    rbac.findRoleByKey.mockResolvedValue(role({ key: 'ADMIN', scope: 'PLATFORM' }));

    await expect(
      command.execute({
        targetUserId: 'user-1',
        roleKey: 'ADMIN',
        organizationId: 'org-1',
        actorUserId: 'admin-1',
      }),
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_ERROR });
  });

  it('conflicts when the role is already assigned', async () => {
    rbac.findAssignment.mockResolvedValue(assignment);

    await expect(
      command.execute({
        targetUserId: 'user-1',
        roleKey: 'PHARMACIST',
        organizationId: 'org-1',
        actorUserId: 'admin-1',
      }),
    ).rejects.toMatchObject({ code: ErrorCode.CONFLICT });
  });

  it('404s for an unknown user', async () => {
    users.findById.mockResolvedValue(null);

    await expect(
      command.execute({ targetUserId: 'missing', roleKey: 'PHARMACIST', actorUserId: 'admin-1' }),
    ).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
  });
});
