import { Controller, Get } from '@nestjs/common';
import { RequirePermissions } from '../../../../shared/rbac/permissions.decorator';
import { ListRoleCatalogueQuery } from '../../application/queries/list-role-catalogue.query';
import { RoleCatalogueResponse, toRoleCatalogueResponse } from '../dtos/role.response';

/**
 * `GET /admin/roles` (module-16 §9.2) — the role catalogue, read-only, on `rbac:read`: the same
 * permission Module 01's own `GET /admin/rbac/roles` takes, held by `ADMIN` and `SUPER_ADMIN`.
 * No route here creates, edits or deletes a role.
 */
@Controller('admin/roles')
export class AdminRolesController {
  constructor(private readonly catalogue: ListRoleCatalogueQuery) {}

  @Get()
  @RequirePermissions('rbac:read')
  async list(): Promise<RoleCatalogueResponse[]> {
    return (await this.catalogue.execute()).map(toRoleCatalogueResponse);
  }
}
