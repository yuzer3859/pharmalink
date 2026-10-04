import { Body, Controller, Get, Param, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { AuthenticatedPrincipal } from '../../../../shared/rbac/rbac.types';
import { RequirePermissions } from '../../../../shared/rbac/permissions.decorator';
import { SetRolePermissionsCommand } from '../../application/commands/set-role-permissions.command';
import { ListPermissionsQuery } from '../../application/queries/list-permissions.query';
import { ListRolesQuery } from '../../application/queries/list-roles.query';
import { CurrentUser } from '../decorators/current-user.decorator';
import { SetRolePermissionsDto } from '../dtos/rbac.dto';

/**
 * Role/permission catalog administration (module-01 §11.7). Reads require `rbac:read`, which
 * Admin holds; mutating the catalog requires `rbac:manage`, which only Super Admin holds (§6.2).
 */
@Controller('admin/rbac')
@RequirePermissions('rbac:read')
export class AdminRbacController {
  constructor(
    private readonly listRoles: ListRolesQuery,
    private readonly listPermissions: ListPermissionsQuery,
    private readonly setRolePermissions: SetRolePermissionsCommand,
  ) {}

  @Get('roles')
  roles() {
    return this.listRoles.execute();
  }

  @Get('permissions')
  permissions() {
    return this.listPermissions.execute();
  }

  @Post('roles/:id/permissions')
  @RequirePermissions('rbac:manage')
  updateRolePermissions(
    @CurrentUser() actor: AuthenticatedPrincipal,
    @Param('id') roleId: string,
    @Body() dto: SetRolePermissionsDto,
    @Req() req: Request,
  ) {
    return this.setRolePermissions.execute({
      roleId,
      permissionKeys: dto.permissions,
      actorUserId: actor.userId,
      ip: req.ip ?? null,
    });
  }
}
