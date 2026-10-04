import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { RequirePermissions } from '../../../../shared/rbac/permissions.decorator';
import { AuthenticatedPrincipal } from '../../../../shared/rbac/rbac.types';
import { CurrentUser } from '../../../identity/interface/decorators/current-user.decorator';
import { ResolveCodDisputeCommand } from '../../application/commands/resolve-cod-dispute.command';
import { GetCodDisputeQuery } from '../../application/queries/get-cod-dispute.query';
import { ListCodDisputesQuery } from '../../application/queries/list-cod-disputes.query';
import { ListCodDisputesQueryDto, ResolveCodDisputeDto } from '../dtos/cod-dispute.dto';
import {
  CodDisputeDetailResponse,
  CodDisputeListResponse,
  CodDisputeResolutionResponse,
  toCodDisputeDetailResponse,
  toCodDisputeListResponse,
  toCodDisputeResolutionResponse,
} from '../dtos/cod-dispute.response';

/**
 * COD dispute management (module-16 §9.6, §11.4, F-AD-20, BRULE-50) — the control-plane view of
 * the disputes Module 08's finance desk raises.
 *
 *     GET  /admin/cod-disputes               every dispute, across collections, newest first
 *     GET  /admin/cod-disputes/{id}          one dispute with the collection's full finance view
 *     POST /admin/cod-disputes/{id}/resolve  forward a resolution to Module 08
 *
 * ## What Module 08 already serves, and is not duplicated here
 *
 * `/admin/delivery/cod-reconciliation/{collectionId}/disputes` (list for one collection, open),
 * and `.../disputes/{disputeId}/resolve`. Those address a dispute through its collection — the
 * desk's shape. This surface addresses it by its own id and lists across collections — the
 * queue's shape. Different prefix, no shadowing, and the resolve route here reaches the *same*
 * `ManageCodDisputeCommand.resolve` through `ICodDisputeAdminPort`. Opening a dispute and filing
 * a correction stay on Module 08's routes: a control plane that raised its own questions or
 * restated its own figures would be a second finance desk.
 *
 * ## Authorization — Module 08's own keys, as found
 *
 * | Route | Permission | Held by |
 * | --- | --- | --- |
 * | the two reads | `finance:report:any` | `FINANCE_OFFICER`, `ADMIN`, `SUPER_ADMIN` |
 * | resolve | `finance:settlement:any` | `FINANCE_OFFICER`, `SUPER_ADMIN` |
 *
 * Exactly the keys Module 08's `AdminCodCorrectionController` uses for the same operations. Note
 * what that means for `ADMIN`: it can see every dispute and cannot close one, because the
 * catalogue reserves cash-handling authority for the finance role — Module 08's separation, kept.
 * No driver role holds either key, so no driver can see or close a dispute about their own cash.
 *
 * ## Actor
 *
 * From the verified access token. The body carries a note and nothing else — no resolver, no
 * outcome, no amount, no status — and `forbidNonWhitelisted` rejects anything more.
 *
 * Errors are not caught — the global filter maps Module 08's own: `NOT_FOUND` (404) for an
 * unknown dispute, `CONFLICT` (409) for a second, *different* conclusion on a resolved dispute,
 * `VALIDATION_ERROR` (400) for an over-long note, `FORBIDDEN` (403) for an unentitled caller.
 */
@Controller('admin/cod-disputes')
export class AdminCodDisputesController {
  constructor(
    private readonly list: ListCodDisputesQuery,
    private readonly getOne: GetCodDisputeQuery,
    private readonly resolve: ResolveCodDisputeCommand,
  ) {}

  @Get()
  @RequirePermissions('finance:report:any')
  async search(@Query() query: ListCodDisputesQueryDto): Promise<CodDisputeListResponse> {
    return toCodDisputeListResponse(
      await this.list.execute({
        status: query.status,
        collectionId: query.collectionId,
        driverId: query.driverId,
        jobId: query.jobId,
        orderId: query.orderId,
        openedFrom: query.openedFrom ? new Date(query.openedFrom) : undefined,
        openedTo: query.openedTo ? new Date(query.openedTo) : undefined,
        resolvedFrom: query.resolvedFrom ? new Date(query.resolvedFrom) : undefined,
        resolvedTo: query.resolvedTo ? new Date(query.resolvedTo) : undefined,
        page: query.page,
        size: query.size,
      }),
    );
  }

  @Get(':id')
  @RequirePermissions('finance:report:any')
  async detail(@Param('id') id: string): Promise<CodDisputeDetailResponse> {
    return toCodDisputeDetailResponse(await this.getOne.execute(id));
  }

  /**
   * `200`, not `201`, as Module 08's own route answers: the response is the dispute as it now
   * stands, whether this call closed it or replayed a conclusion already recorded (`changed`).
   */
  @Post(':id/resolve')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('finance:settlement:any')
  async resolveOne(
    @CurrentUser() actor: AuthenticatedPrincipal,
    @Param('id') id: string,
    @Body() body: ResolveCodDisputeDto,
    @Req() req: Request,
  ): Promise<CodDisputeResolutionResponse> {
    return toCodDisputeResolutionResponse(
      await this.resolve.execute({
        // From the token. There is no DTO field through which an actor could arrive.
        actorUserId: actor.userId,
        disputeId: id,
        resolutionNote: body.resolutionNote ?? null,
        ip: req.ip ?? null,
      }),
    );
  }
}
