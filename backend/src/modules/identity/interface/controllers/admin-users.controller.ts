import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { AuthenticatedPrincipal } from '../../../../shared/rbac/rbac.types';
import { RequirePermissions } from '../../../../shared/rbac/permissions.decorator';
import { AssignUserRoleCommand } from '../../application/commands/assign-user-role.command';
import { ReactivateUserCommand } from '../../application/commands/reactivate-user.command';
import { RevokeUserRoleCommand } from '../../application/commands/revoke-user-role.command';
import { SuspendUserCommand } from '../../application/commands/suspend-user.command';
import { ListUserRolesQuery } from '../../application/queries/list-user-roles.query';
import { CurrentUser } from '../decorators/current-user.decorator';
import { AssignRoleDto, SuspendUserDto } from '../dtos/rbac.dto';

/**
 * Per-user administration (module-01 §11.7). The class-level default covers reading a user's
 * roles; every mutating route declares the narrower permission it actually needs, which
 * overrides the default.
 */
@Controller('admin/users')
@RequirePermissions('rbac:read')
export class AdminUsersController {
  constructor(
    private readonly listUserRoles: ListUserRolesQuery,
    private readonly assignUserRole: AssignUserRoleCommand,
    private readonly revokeUserRole: RevokeUserRoleCommand,
    private readonly suspendUser: SuspendUserCommand,
    private readonly reactivateUser: ReactivateUserCommand,
  ) {}

  @Get(':id/roles')
  roles(@Param('id') userId: string) {
    return this.listUserRoles.execute(userId);
  }

  @Post(':id/roles')
  @RequirePermissions('rbac:manage')
  @HttpCode(HttpStatus.CREATED)
  assign(
    @CurrentUser() actor: AuthenticatedPrincipal,
    @Param('id') userId: string,
    @Body() dto: AssignRoleDto,
    @Req() req: Request,
  ) {
    return this.assignUserRole.execute({
      targetUserId: userId,
      roleKey: dto.roleKey,
      organizationId: dto.organizationId ?? null,
      actorUserId: actor.userId,
      ip: req.ip ?? null,
    });
  }

  @Delete(':id/roles/:assignmentId')
  @RequirePermissions('rbac:manage')
  @HttpCode(HttpStatus.NO_CONTENT)
  async revoke(
    @CurrentUser() actor: AuthenticatedPrincipal,
    @Param('id') userId: string,
    @Param('assignmentId') assignmentId: string,
    @Req() req: Request,
  ): Promise<void> {
    await this.revokeUserRole.execute({
      targetUserId: userId,
      assignmentId,
      actorUserId: actor.userId,
      ip: req.ip ?? null,
    });
  }

  @Post(':id/suspend')
  @RequirePermissions('user:suspend:any')
  @HttpCode(HttpStatus.NO_CONTENT)
  async suspend(
    @CurrentUser() actor: AuthenticatedPrincipal,
    @Param('id') userId: string,
    @Body() dto: SuspendUserDto,
    @Req() req: Request,
  ): Promise<void> {
    await this.suspendUser.execute({
      targetUserId: userId,
      reason: dto.reason,
      actorUserId: actor.userId,
      ip: req.ip ?? null,
    });
  }

  @Post(':id/reactivate')
  @RequirePermissions('user:reactivate:any')
  @HttpCode(HttpStatus.NO_CONTENT)
  async reactivate(
    @CurrentUser() actor: AuthenticatedPrincipal,
    @Param('id') userId: string,
    @Req() req: Request,
  ): Promise<void> {
    await this.reactivateUser.execute({
      targetUserId: userId,
      actorUserId: actor.userId,
      ip: req.ip ?? null,
    });
  }
}
