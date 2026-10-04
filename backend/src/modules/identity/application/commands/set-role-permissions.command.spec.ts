import { AuditService } from '../../../../shared/audit/audit.service';
import { ApiException } from '../../../../shared/errors/api-exception';
import { ErrorCode } from '../../../../shared/errors/error-codes';
import { IRbacRepository, RoleRecord } from '../../domain/repositories/rbac.repository';
import { PermissionChangeService } from '../services/permission-change.service';
import { SetRolePermissionsCommand } from './set-role-permissions.command';

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

function permission(key: string, id: string) {
  return { id, key, resource: key.split(':')[0], action: key.split(':')[1], scope: null, description: null };
}

describe('SetRolePermissionsCommand', () => {
  let rbac: jest.Mocked<IRbacRepository>;
  let permissionChange: jest.Mocked<PermissionChangeService>;
  let audit: jest.Mocked<AuditService>;
  let command: SetRolePermissionsCommand;

  beforeEach(() => {
    rbac = {
      findRoleById: jest.fn().mockResolvedValue(role()),
      findPermissionsByKeys: jest
        .fn()
        .mockResolvedValue([permission('order:read:org', 'perm-1'), permission('prescription:verify', 'perm-2')]),
      replaceRolePermissions: jest.fn().mockResolvedValue(undefined),
      listUserIdsWithRole: jest.fn().mockResolvedValue(['user-1', 'user-2']),
    } as unknown as jest.Mocked<IRbacRepository>;
    permissionChange = { propagate: jest.fn().mockResolvedValue(undefined) } as unknown as jest.Mocked<PermissionChangeService>;
    audit = { record: jest.fn().mockResolvedValue({ id: 'a', hash: 'h' }) } as unknown as jest.Mocked<AuditService>;
    command = new SetRolePermissionsCommand(rbac, permissionChange, audit);
  });

  it('replaces the permission set, propagates the change and audits it', async () => {
    const result = await command.execute({
      roleId: 'role-1',
      permissionKeys: ['order:read:org', 'prescription:verify', 'order:read:org'],
      actorUserId: 'admin-1',
      ip: '10.0.0.1',
    });

    expect(rbac.replaceRolePermissions).toHaveBeenCalledWith('role-1', ['perm-1', 'perm-2']);
    expect(permissionChange.propagate).toHaveBeenCalledWith(['user-1', 'user-2']);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'rbac.role_permissions.replaced', resourceId: 'role-1' }),
    );
    expect(result.permissions).toEqual(['order:read:org', 'prescription:verify']);
    expect(result.affectedUsers).toBe(2);
  });

  it('rejects unknown permission keys before touching the role', async () => {
    rbac.findPermissionsByKeys.mockResolvedValue([permission('order:read:org', 'perm-1')]);

    await expect(
      command.execute({ roleId: 'role-1', permissionKeys: ['order:read:org', 'bogus:key'], actorUserId: 'admin-1' }),
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_ERROR });
    expect(rbac.replaceRolePermissions).not.toHaveBeenCalled();
  });

  it('refuses to edit the SUPER_ADMIN role', async () => {
    rbac.findRoleById.mockResolvedValue(role({ key: 'SUPER_ADMIN', scope: 'PLATFORM' }));

    await expect(
      command.execute({ roleId: 'role-1', permissionKeys: [], actorUserId: 'admin-1' }),
    ).rejects.toMatchObject({ code: ErrorCode.BUSINESS_RULE_VIOLATION });
    expect(rbac.replaceRolePermissions).not.toHaveBeenCalled();
  });

  it('404s for an unknown role', async () => {
    rbac.findRoleById.mockResolvedValue(null);

    await expect(
      command.execute({ roleId: 'missing', permissionKeys: [], actorUserId: 'admin-1' }),
    ).rejects.toBeInstanceOf(ApiException);
  });
});
