import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { RequirePermissions } from '../../../../shared/rbac/permissions.decorator';
import { AuthenticatedPrincipal } from '../../../../shared/rbac/rbac.types';
import { CurrentUser } from '../../../identity/interface/decorators/current-user.decorator';
import {
  IDENTITY_IMPERSONATION_PORT,
  IIdentityImpersonationPort,
  SUPPORT_IMPERSONATE_PERMISSION,
} from '../../../identity/application/ports/inbound/identity-impersonation.port';
import { toApprovalView } from '../../application/maker-checker/approval-queries';
import { MakerCheckerGate } from '../../application/maker-checker/maker-checker-gate.service';
import { IMPERSONATION_START_ACTION } from '../../infrastructure/maker-checker/impersonation.actions';
import { RequireIdempotencyKey } from '../decorators/idempotency-key.decorator';
import { toApprovalResponse } from '../dtos/approval.response';
import { ImpersonationRequestDto, ListImpersonationSessionsDto } from '../dtos/impersonation.dto';

/**
 * Support "view as" (Work 85; module-16 §9.2 `POST /admin/users/{id}/impersonate`, F-AD-08,
 * backend/docs/impersonation.md). Ask → a second administrator approves on the Approvals page →
 * the asker starts it and receives a 15-minute read-only token for the account. Everything is
 * `support:impersonate:any` (ADMIN; SUPER_ADMIN by wildcard) and audited.
 */
@Controller('admin')
@RequirePermissions(SUPPORT_IMPERSONATE_PERMISSION)
export class AdminImpersonationController {
  constructor(
    private readonly gate: MakerCheckerGate,
    @Inject(IDENTITY_IMPERSONATION_PORT) private readonly impersonation: IIdentityImpersonationPort,
  ) {}

  @Post('accounts/:id/impersonate')
  async request(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Param('id', new ParseUUIDPipe()) targetUserId: string,
    @Body() body: ImpersonationRequestDto,
    @RequireIdempotencyKey() idempotencyKey: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    // Refuse a platform account, oneself or an inactive one before anybody is asked to approve it.
    await this.impersonation.assertImpersonable(targetUserId, user.userId);
    const result = await this.gate.submit({
      actionType: IMPERSONATION_START_ACTION,
      payload: { targetUserId, reason: body.reason },
      makerUserId: user.userId,
      makerPermissions: user.permissions ?? [],
      idempotencyKey,
      reason: body.reason,
      ip: req.ip ?? null,
    });
    if (result.outcome === 'EXECUTED') {
      res.status(HttpStatus.OK);
      return { outcome: 'EXECUTED', result: result.result };
    }
    res.status(HttpStatus.ACCEPTED);
    return {
      outcome: 'MAKER_CHECKER_PENDING',
      approval: toApprovalResponse(
        toApprovalView(result.approval, { userId: user.userId, permissions: user.permissions ?? [] }, new Date()),
      ),
    };
  }

  @Get('impersonation-sessions')
  list(@CurrentUser() user: AuthenticatedPrincipal, @Query() query: ListImpersonationSessionsDto) {
    return this.impersonation.list(
      {
        requestedByUserId: query.mine === 'false' ? undefined : user.userId,
        targetUserId: query.targetUserId,
      },
      query.page ?? 1,
      query.size ?? 20,
    );
  }

  @Post('impersonation-sessions/:id/start')
  @HttpCode(HttpStatus.OK)
  start(@CurrentUser() user: AuthenticatedPrincipal, @Param('id', new ParseUUIDPipe()) id: string, @Req() req: Request) {
    return this.impersonation.start(id, user.userId, req.ip ?? null);
  }

  @Post('impersonation-sessions/:id/end')
  @HttpCode(HttpStatus.OK)
  end(@CurrentUser() user: AuthenticatedPrincipal, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.impersonation.end(id, user.userId);
  }
}
