import { AuditService } from '../../../../shared/audit/audit.service';
import { ErrorCode } from '../../../../shared/errors/error-codes';
import { IRbacRepository, UserRoleRecord } from '../../domain/repositories/rbac.repository';
import { PermissionChangeService } from '../services/permission-change.service';
import { RevokeUserRoleCommand } from './revoke-user-role.command';

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

describe('RevokeUserRoleCommand', () => {
  let rbac: jest.Mocked<IRbacRepository>;
  let permissionChange: jest.Mocked<PermissionChangeService>;
  let audit: jest.Mocked<AuditService>;
  let command: RevokeUserRoleCommand;

  beforeEach(() => {
    rbac = {
      findAssignmentById: jest.fn().mockResolvedValue(assignment),
      deleteAssignment: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<IRbacRepository>;
    permissionChange = { propagate: jest.fn().mockResolvedValue(undefined) } as unknown as jest.Mocked<PermissionChangeService>;
    audit = { record: jest.fn().mockResolvedValue({ id: 'a', hash: 'h' }) } as unknown as jest.Mocked<AuditService>;
    command = new RevokeUserRoleCommand(rbac, permissionChange, audit);
  });

  it('revokes the assignment, propagates and audits', async () => {
    await command.execute({
      targetUserId: 'user-1',
      assignmentId: 'assignment-1',
      actorUserId: 'admin-1',
    });

    expect(rbac.deleteAssignment).toHaveBeenCalledWith('assignment-1');
    expect(permissionChange.propagate).toHaveBeenCalledWith(['user-1']);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'rbac.user_role.revoked' }),
    );
  });

  it('refuses to revoke an assignment belonging to another user', async () => {
    await expect(
      command.execute({
        targetUserId: 'someone-else',
        assignmentId: 'assignment-1',
        actorUserId: 'admin-1',
      }),
    ).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
    expect(rbac.deleteAssignment).not.toHaveBeenCalled();
  });
});
