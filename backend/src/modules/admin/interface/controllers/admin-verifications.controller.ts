import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { RequirePermissions } from '../../../../shared/rbac/permissions.decorator';
import { AuthenticatedPrincipal } from '../../../../shared/rbac/rbac.types';
import { CurrentUser } from '../../../identity/interface/decorators/current-user.decorator';
import { ApproveVerificationCommand } from '../../application/commands/approve-verification.command';
import { RejectVerificationCommand } from '../../application/commands/reject-verification.command';
import { GetVerificationQuery } from '../../application/queries/get-verification.query';
import { ListVerificationQueueQuery } from '../../application/queries/list-verification-queue.query';
import {
  ApproveVerificationDto,
  ListVerificationsQueryDto,
  RejectVerificationDto,
} from '../dtos/verification.dto';
import {
  VerificationDecisionResponse,
  VerificationDetailResponse,
  VerificationQueueResponse,
  toVerificationDecisionResponse,
  toVerificationDetailResponse,
  toVerificationQueueResponse,
} from '../dtos/verification.response';

/**
 * Verification management (module-16 §9.1, FR-ADM-01).
 *
 *     GET  /admin/verifications               the queue — PENDING by default, filterable
 *     GET  /admin/verifications/{id}          one request, with its document references
 *     POST /admin/verifications/{id}/approve  forward an approval to Module 01
 *     POST /admin/verifications/{id}/reject   forward a rejection to Module 01
 *
 * There is no `request-documents` route. Module 01 has no such operation — an applicant attaches
 * documents to their own open request; nobody asks for them — and a route here would need a
 * verification state Module 01 does not define. It stays deferred to Module 01's contract.
 *
 * ## Authorization
 *
 * The design names `verification:manage`. The catalogue has no such key; what it has is the pair
 * Module 01 §9.4 already split for separation of duties — `verification:queue:read` for looking
 * and `provider:verify:any` for deciding — and Module 01's own `/admin/verification` routes are
 * gated on exactly those. This controller uses the same two, so an administrator who may decide
 * a request through Module 01 may decide it here and nobody else may. No permission was invented,
 * no grant was widened: both keys have been in the `ADMIN` role's list since Module 01 (and in
 * `SUPER_ADMIN`'s via `'*'`), and `CUSTOMER`, `DRIVER`, `PHARMACY_OWNER`, `CUSTOMER_SUPPORT` and
 * `FINANCE_OFFICER` hold neither.
 *
 * ## Actor
 *
 * The reviewer is the authenticated principal on every mutation. No DTO carries a reviewer or
 * actor field; `forbidNonWhitelisted` rejects a body that invents one. Module 01's aggregate then
 * applies its own separation-of-duties rule against that identity — a reviewer cannot approve
 * their own request through this surface any more than through Module 01's.
 *
 * ## Decisions answer `200`, not `204`
 *
 * Module 01's routes answer `204`. These return the decision — the transition, the timestamp,
 * the licence expiry — because an administrator working a queue needs to see what happened
 * without a second read, and because the response is the same projection the audit entry
 * recorded.
 *
 * Errors are not caught — the global filter maps Module 01's own: `NOT_FOUND` (404) for an
 * unknown id, `BUSINESS_RULE_VIOLATION` (422) for a request already decided (including the loser
 * of a concurrent decision), `FORBIDDEN` (403) for self-review and — from `PermissionsGuard` — for
 * an unentitled caller.
 */
@Controller('admin/verifications')
export class AdminVerificationsController {
  constructor(
    private readonly listQueue: ListVerificationQueueQuery,
    private readonly getOne: GetVerificationQuery,
    private readonly approve: ApproveVerificationCommand,
    private readonly reject: RejectVerificationCommand,
  ) {}

  @Get()
  @RequirePermissions('verification:queue:read')
  async list(@Query() query: ListVerificationsQueryDto): Promise<VerificationQueueResponse> {
    return toVerificationQueueResponse(
      await this.listQueue.execute({
        status: query.status,
        type: query.type,
        userId: query.userId,
        organizationId: query.organizationId,
        submittedFrom: query.submittedFrom ? new Date(query.submittedFrom) : undefined,
        submittedTo: query.submittedTo ? new Date(query.submittedTo) : undefined,
        page: query.page,
        size: query.size,
      }),
    );
  }

  @Get(':id')
  @RequirePermissions('verification:queue:read')
  async detail(@Param('id') id: string): Promise<VerificationDetailResponse> {
    return toVerificationDetailResponse(await this.getOne.execute(id));
  }

  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('provider:verify:any')
  async approveOne(
    @CurrentUser() reviewer: AuthenticatedPrincipal,
    @Param('id') id: string,
    @Body() body: ApproveVerificationDto,
    @Req() req: Request,
  ): Promise<VerificationDecisionResponse> {
    return toVerificationDecisionResponse(
      await this.approve.execute({
        // From the token. There is no DTO field through which a reviewer could arrive.
        actorUserId: reviewer.userId,
        requestId: id,
        expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
        reason: body.reason ?? null,
        ip: req.ip ?? null,
      }),
    );
  }

  @Post(':id/reject')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('provider:verify:any')
  async rejectOne(
    @CurrentUser() reviewer: AuthenticatedPrincipal,
    @Param('id') id: string,
    @Body() body: RejectVerificationDto,
    @Req() req: Request,
  ): Promise<VerificationDecisionResponse> {
    return toVerificationDecisionResponse(
      await this.reject.execute({
        actorUserId: reviewer.userId,
        requestId: id,
        reason: body.reason,
        ip: req.ip ?? null,
      }),
    );
  }
}
