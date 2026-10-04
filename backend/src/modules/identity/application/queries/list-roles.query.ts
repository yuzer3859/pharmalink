import { Inject, Injectable } from '@nestjs/common';
import { IRbacRepository, RBAC_REPOSITORY } from '../../domain/repositories/rbac.repository';

export interface RoleView {
  id: string;
  key: string;
  name: string;
  scope: string;
  isSystem: boolean;
  description: string | null;
  permissions: string[];
}

/** GET /admin/rbac/roles (module-01 §11.7, permission `rbac:manage`). */
@Injectable()
export class ListRolesQuery {
  constructor(@Inject(RBAC_REPOSITORY) private readonly rbac: IRbacRepository) {}

  async execute(): Promise<RoleView[]> {
    const roles = await this.rbac.listRoles();
    return roles.map((role) => ({
      id: role.id,
      key: role.key,
      name: role.name,
      scope: role.scope,
      isSystem: role.isSystem,
      description: role.description,
      permissions: role.permissionKeys,
    }));
  }
}
