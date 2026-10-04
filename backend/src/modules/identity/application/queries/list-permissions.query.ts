import { Inject, Injectable } from '@nestjs/common';
import { IRbacRepository, RBAC_REPOSITORY } from '../../domain/repositories/rbac.repository';

export interface PermissionView {
  id: string;
  key: string;
  resource: string;
  action: string;
  scope: string | null;
  description: string | null;
}

/** GET /admin/rbac/permissions (module-01 §6.2, §11.7). */
@Injectable()
export class ListPermissionsQuery {
  constructor(@Inject(RBAC_REPOSITORY) private readonly rbac: IRbacRepository) {}

  async execute(): Promise<PermissionView[]> {
    const permissions = await this.rbac.listPermissions();
    return permissions.map((permission) => ({
      id: permission.id,
      key: permission.key,
      resource: permission.resource,
      action: permission.action,
      scope: permission.scope,
      description: permission.description,
    }));
  }
}
