import { ErrorCode } from '../../../../shared/errors/error-codes';
import { IRbacRepository, UserRoleRecord } from '../../domain/repositories/rbac.repository';
import { IUserRepository } from '../../domain/repositories/user.repository';
import { ListUserRolesQuery } from './list-user-roles.query';

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

describe('ListUserRolesQuery', () => {
  it('maps the user role assignments', async () => {
    const rbac = {
      listAssignmentsForUser: jest.fn().mockResolvedValue([assignment]),
    } as unknown as IRbacRepository;
    const users = { findById: jest.fn().mockResolvedValue({ id: 'user-1' }) } as unknown as IUserRepository;

    const result = await new ListUserRolesQuery(rbac, users).execute('user-1');

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ assignmentId: 'assignment-1', roleKey: 'PHARMACIST', organizationId: 'org-1' });
  });

  it('404s for an unknown user', async () => {
    const rbac = { listAssignmentsForUser: jest.fn() } as unknown as IRbacRepository;
    const users = { findById: jest.fn().mockResolvedValue(null) } as unknown as IUserRepository;

    await expect(new ListUserRolesQuery(rbac, users).execute('missing')).rejects.toMatchObject({
      code: ErrorCode.NOT_FOUND,
    });
    expect(rbac.listAssignmentsForUser).not.toHaveBeenCalled();
  });
});
