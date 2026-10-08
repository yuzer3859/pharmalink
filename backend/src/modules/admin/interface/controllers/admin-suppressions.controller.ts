import { Controller, Delete, Get, Param, ParseUUIDPipe, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { RequirePermissions } from '../../../../shared/rbac/permissions.decorator';
import { AuthenticatedPrincipal } from '../../../../shared/rbac/rbac.types';
import { CurrentUser } from '../../../identity/interface/decorators/current-user.decorator';
import { RemoveSuppressionCommand } from '../../application/commands/remove-suppression.command';
import { GetSuppressionQuery } from '../../application/queries/get-suppression.query';
import { ListSuppressionsQuery } from '../../application/queries/list-suppressions.query';
import { ListSuppressionsQueryDto } from '../dtos/suppression.dto';
import {
  SuppressionListResponse,
  SuppressionResponse,
  toSuppressionListResponse,
  toSuppressionResponse,
} from '../dtos/suppression.response';

/**
 * The notification suppression list, for administrators (module-13 Work 19). Module 13 owns the
 * data and the rules; this controller is the control plane over `NOTIFICATION_SUPPRESSION_ADMIN_PORT`.
 *
 *     GET    /admin/notifications/suppressions        ?channel &reason &createdFrom &createdTo &page &size
 *     GET    /admin/notifications/suppressions/:id
 *     DELETE /admin/notifications/suppressions/:id    → 200 with the removed suppression; audited
 *
 * Reads take `suppression:read:any`, removal `suppression:manage:any` — ADMIN only. Removing lets
 * future sends to the destination be attempted; it reopens and resends nothing.
 */
@Controller('admin/notifications/suppressions')
export class AdminSuppressionsController {
  constructor(
    private readonly list: ListSuppressionsQuery,
    private readonly getOne: GetSuppressionQuery,
    private readonly remove: RemoveSuppressionCommand,
  ) {}

  @Get()
  @RequirePermissions('suppression:read:any')
  async search(@Query() query: ListSuppressionsQueryDto): Promise<SuppressionListResponse> {
    return toSuppressionListResponse(
      await this.list.execute({
        channel: query.channel,
        reason: query.reason,
        createdFrom: query.createdFrom ? new Date(query.createdFrom) : undefined,
        createdTo: query.createdTo ? new Date(query.createdTo) : undefined,
        page: query.page,
        size: query.size,
      }),
    );
  }

  @Get(':id')
  @RequirePermissions('suppression:read:any')
  async detail(@Param('id', new ParseUUIDPipe()) id: string): Promise<SuppressionResponse> {
    return toSuppressionResponse(await this.getOne.execute(id));
  }

  @Delete(':id')
  @RequirePermissions('suppression:manage:any')
  async removeOne(
    @CurrentUser() actor: AuthenticatedPrincipal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ): Promise<SuppressionResponse> {
    return toSuppressionResponse(
      await this.remove.execute({
        // From the token. There is no body, so no field through which an actor could arrive.
        actorUserId: actor.userId,
        suppressionId: id,
        ip: req.ip ?? null,
      }),
    );
  }
}
