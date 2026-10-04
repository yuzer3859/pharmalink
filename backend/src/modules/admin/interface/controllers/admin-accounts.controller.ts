import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { RequirePermissions } from '../../../../shared/rbac/permissions.decorator';
import { AuthenticatedPrincipal } from '../../../../shared/rbac/rbac.types';
import { CurrentUser } from '../../../identity/interface/decorators/current-user.decorator';
import { AssignRoleCommand } from '../../application/commands/assign-role.command';
import { ReinstateUserCommand } from '../../application/commands/reinstate-user.command';
import { RevokeRoleCommand } from '../../application/commands/revoke-role.command';
import { SuspendUserCommand } from '../../application/commands/suspend-user.command';
import { GetUserQuery } from '../../application/queries/get-user.query';
import { GetUserRolesQuery } from '../../application/queries/get-user-roles.query';
import { ListUsersQuery } from '../../application/queries/list-users.query';
import { AssignRoleDto } from '../dtos/role.dto';
import {
  RoleChangeResponse,
  toRoleChangeResponse,
  toUserRoleAssignmentResponse,
} from '../dtos/role.response';
import { ListUsersQueryDto, ReinstateUserDto, SuspendUserDto } from '../dtos/user.dto';
import {
  AccountStatusChangeResponse,
  UserDetailResponse,
  UserListResponse,
  UserRoleAssignmentResponse,
  toAccountStatusChangeResponse,
  toUserDetailResponse,
  toUserListResponse,
} from '../dtos/user.response';

/**
 * User & account management (module-16 §9.2, FR-ADM-02/03, BRULE-49).
 *
 *     GET    /admin/accounts                            search accounts
 *     GET    /admin/accounts/{id}                       one account, with its role assignments
 *     POST   /admin/accounts/{id}/suspend               forward a suspension to Module 01
 *     POST   /admin/accounts/{id}/reinstate             forward a reactivation to Module 01
 *     GET    /admin/accounts/{id}/roles                 the account's role assignments (Work 04)
 *     POST   /admin/accounts/{id}/roles                 assign an existing role (Work 04)
 *     DELETE /admin/accounts/{id}/roles/{assignmentId}  revoke one assignment (Work 04)
 *
 * ## Roles: what Module 01 enforces, and what it does not
 *
 * Assignment and revocation delegate to Module 01's `AssignUserRoleCommand` and
 * `RevokeUserRoleCommand`, and every rule those apply applies here: the user and the role must
 * exist; an `ORG`-scoped role (`PHARMACY_OWNER`, `PHARMACY_MANAGER`, `PHARMACIST`, `CASHIER`,
 * `INVENTORY_STAFF`, `HOSPITAL_ADMIN`, `DIAGNOSTIC_CENTER_ADMIN`) must name an existing
 * organization and a `PLATFORM`/`INDIVIDUAL` role must not; the same role under the same
 * organization cannot be assigned twice (`CONFLICT`); a revocation must name an assignment that
 * belongs to the path's user (`NOT_FOUND` otherwise). Both mutations bump the target's
 * `permVersion`, so the change takes effect on their next request.
 *
 * **Module 01 has no rule about which roles may be granted to whom.** Nothing there refuses
 * assigning `SUPER_ADMIN` or `ADMIN`, changing another administrator's roles, changing one's
 * own, or revoking one's own last administrative role. What protects against escalation is the
 * gate on the operation itself: both mutations require `rbac:manage`, which the catalogue grants
 * to `SUPER_ADMIN` alone (`ADMIN` holds `rbac:read`). So an `ADMIN` cannot grant anyone anything,
 * and a `SUPER_ADMIN` — who already holds `'*'` — can grant anything, including to themselves.
 * That is the repository's actual policy, and this controller applies it exactly rather than
 * adding a narrower rule Module 01's own `/admin/users/:id/roles` would not apply. Whether
 * self-revocation of the last `SUPER_ADMIN` should be refused is a policy decision for Module 01
 * (see the work report).
 *
 * ## Why `/admin/accounts` and not the design's `/admin/users`
 *
 * Module 01 already serves `/admin/users`: `GET :id/roles`, `POST :id/roles`,
 * `DELETE :id/roles/:assignmentId`, `POST :id/suspend`, `POST :id/reactivate` (module-01 §11.7,
 * `AdminUsersController`). A second `POST /admin/users/:id/suspend` here would be registered
 * behind Module 01's and never reached — Express answers the first matching route — so the admin
 * surface would silently be Module 01's (`204`, no Module 16 audit) while appearing to be this
 * one. Retiring Module 01's route is not this work's decision to make, and shadowing it by
 * registration order would change Module 01's own HTTP contract. The one prefix Module 01 does
 * not own is used instead, for every route, so the surface is consistent and cannot be
 * shadowed. Work 02 made the same move for the same reason (`/admin/verifications` beside
 * Module 01's `/admin/verification`).
 *
 * ## Authorization
 *
 * The exact keys Module 01's own routes use: `user:suspend:any` for suspension,
 * `user:reactivate:any` for reinstatement, both in the `ADMIN` role's list since Module 01 and
 * in `SUPER_ADMIN`'s via `'*'`. The reads take `rbac:read` — the permission Module 01's
 * `AdminUsersController` sets as its class default for reading a user's roles, which is the
 * closest existing "read an account for administration" key; the catalogue has no `user:read:any`
 * and inventing one would mean inventing its grant. `CUSTOMER`, `DRIVER`, `PHARMACY_OWNER`,
 * `CUSTOMER_SUPPORT` and `FINANCE_OFFICER` hold none of the three.
 *
 * ## Actor
 *
 * From the verified access token on every mutation. No DTO carries an actor; `forbidNonWhitelisted`
 * rejects a body that invents one. Module 01's own self-suspension refusal then applies to that
 * identity.
 *
 * ## Responses
 *
 * Module 01's routes answer `204`; these return the transition (`previousStatus`, `status`,
 * `changedAt`) — the same projection the audit entry records — so an administrator sees what
 * happened, including Module 01's idempotent no-op on an already-suspended account, which
 * comes back as `previousStatus === status`.
 *
 * Errors are not caught — the global filter maps Module 01's own: `NOT_FOUND` (404) for an
 * unknown id, `BUSINESS_RULE_VIOLATION` (422) for a transition the aggregate refuses or for
 * self-suspension, `FORBIDDEN` (403) from `PermissionsGuard` for an unentitled caller.
 */
@Controller('admin/accounts')
export class AdminAccountsController {
  constructor(
    private readonly listUsers: ListUsersQuery,
    private readonly getUser: GetUserQuery,
    private readonly suspend: SuspendUserCommand,
    private readonly reinstate: ReinstateUserCommand,
    private readonly getUserRoles: GetUserRolesQuery,
    private readonly assign: AssignRoleCommand,
    private readonly revoke: RevokeRoleCommand,
  ) {}

  @Get()
  @RequirePermissions('rbac:read')
  async list(@Query() query: ListUsersQueryDto): Promise<UserListResponse> {
    return toUserListResponse(
      await this.listUsers.execute({
        status: query.status,
        primaryRole: query.primaryRole,
        identifier: query.identifier,
        page: query.page,
        size: query.size,
      }),
    );
  }

  @Get(':id')
  @RequirePermissions('rbac:read')
  async detail(@Param('id') id: string): Promise<UserDetailResponse> {
    return toUserDetailResponse(await this.getUser.execute(id));
  }

  @Get(':id/roles')
  @RequirePermissions('rbac:read')
  async roles(@Param('id') id: string): Promise<UserRoleAssignmentResponse[]> {
    return (await this.getUserRoles.execute(id)).map(toUserRoleAssignmentResponse);
  }

  /** `201`: an assignment was created and its id is in the body. */
  @Post(':id/roles')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions('rbac:manage')
  async assignRole(
    @CurrentUser() actor: AuthenticatedPrincipal,
    @Param('id') id: string,
    @Body() body: AssignRoleDto,
    @Req() req: Request,
  ): Promise<RoleChangeResponse> {
    return toRoleChangeResponse(
      await this.assign.execute({
        actorUserId: actor.userId,
        targetUserId: id,
        roleKey: body.roleKey,
        organizationId: body.organizationId ?? null,
        ip: req.ip ?? null,
      }),
    );
  }

  /** `200` with the role set that remains, rather than `204`, so the caller sees what is left. */
  @Delete(':id/roles/:assignmentId')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('rbac:manage')
  async revokeRole(
    @CurrentUser() actor: AuthenticatedPrincipal,
    @Param('id') id: string,
    @Param('assignmentId') assignmentId: string,
    @Req() req: Request,
  ): Promise<RoleChangeResponse> {
    return toRoleChangeResponse(
      await this.revoke.execute({
        actorUserId: actor.userId,
        targetUserId: id,
        assignmentId,
        ip: req.ip ?? null,
      }),
    );
  }

  @Post(':id/suspend')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('user:suspend:any')
  async suspendOne(
    @CurrentUser() actor: AuthenticatedPrincipal,
    @Param('id') id: string,
    @Body() body: SuspendUserDto,
    @Req() req: Request,
  ): Promise<AccountStatusChangeResponse> {
    return toAccountStatusChangeResponse(
      await this.suspend.execute({
        // From the token. There is no DTO field through which an actor could arrive.
        actorUserId: actor.userId,
        targetUserId: id,
        reason: body.reason,
        ip: req.ip ?? null,
      }),
    );
  }

  @Post(':id/reinstate')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('user:reactivate:any')
  async reinstateOne(
    @CurrentUser() actor: AuthenticatedPrincipal,
    @Param('id') id: string,
    @Body() body: ReinstateUserDto,
    @Req() req: Request,
  ): Promise<AccountStatusChangeResponse> {
    return toAccountStatusChangeResponse(
      await this.reinstate.execute({
        actorUserId: actor.userId,
        targetUserId: id,
        reason: body.reason ?? null,
        ip: req.ip ?? null,
      }),
    );
  }
}
