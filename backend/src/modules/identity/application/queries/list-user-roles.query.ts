import { Inject, Injectable } from '@nestjs/common';
import { ApiException } from '../../../../shared/errors/api-exception';
import { IRbacRepository, RBAC_REPOSITORY } from '../../domain/repositories/rbac.repository';
import { IUserRepository, USER_REPOSITORY } from '../../domain/repositories/user.repository';

export interface UserRoleView {
  assignmentId: string;
  roleId: string;
  roleKey: string;
  roleName: string;
  organizationId: string | null;
  assignedBy: string | null;
  createdAt: Date;
}

/** GET /admin/users/{id}/roles (module-01 §11.7). */
@Injectable()
export class ListUserRolesQuery {
  constructor(
    @Inject(RBAC_REPOSITORY) private readonly rbac: IRbacRepository,
    @Inject(USER_REPOSITORY) private readonly users: IUserRepository,
  ) {}

  async execute(userId: string): Promise<UserRoleView[]> {
    const user = await this.users.findById(userId);
    if (!user) {
      throw ApiException.notFound('User not found');
    }

    const assignments = await this.rbac.listAssignmentsForUser(userId);
    return assignments.map((assignment) => ({
      assignmentId: assignment.id,
      roleId: assignment.roleId,
      roleKey: assignment.roleKey,
      roleName: assignment.roleName,
      organizationId: assignment.organizationId,
      assignedBy: assignment.assignedBy,
      createdAt: assignment.createdAt,
    }));
  }
}
