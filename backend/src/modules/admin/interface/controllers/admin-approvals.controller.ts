import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { RequirePermissions } from '../../../../shared/rbac/permissions.decorator';
import { AuthenticatedPrincipal } from '../../../../shared/rbac/rbac.types';
import { CurrentUser } from '../../../identity/interface/decorators/current-user.decorator';
import {
  ApprovalReader,
  GetApprovalQuery,
  ListApprovalActionsQuery,
  ListApprovalsQuery,
  toApprovalView,
} from '../../application/maker-checker/approval-queries';
import { DecideApprovalCommand } from '../../application/maker-checker/decide-approval.command';
import { DecideApprovalDto, ListApprovalsQueryDto } from '../dtos/approval.dto';
import {
  ApprovalActionsResponse,
  ApprovalListResponse,
  ApprovalResponse,
  toApprovalListResponse,
  toApprovalResponse,
} from '../dtos/approval.response';

/** Reading the maker-checker queue (Work 82). Deciding also needs the action's own permission. */
export const APPROVAL_READ_PERMISSION = 'approval:read:any';

/**
 * Maker-checker requests (module-16 §11.2, NFR-SEC-06, backend/docs/maker-checker.md).
 *
 * The route permission lets an administrator see the queue; whether they may *decide* a request is
 * the action's own permission (`requiredPermission`), checked in `DecideApprovalCommand` with the
 * permissions in their token, and never their own request.
 */
@Controller('admin/approvals')
export class AdminApprovalsController {
  constructor(
    private readonly list: ListApprovalsQuery,
    private readonly getOne: GetApprovalQuery,
    private readonly actions: ListApprovalActionsQuery,
    private readonly decide: DecideApprovalCommand,
  ) {}

  @Get()
  @RequirePermissions(APPROVAL_READ_PERMISSION)
  async search(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Query() query: ListApprovalsQueryDto,
  ): Promise<ApprovalListResponse> {
    return toApprovalListResponse(
      await this.list.execute({
        reader: readerOf(user),
        status: query.status,
        actionType: query.actionType,
        mine: query.mine === 'true',
        page: query.page,
        size: query.size,
      }),
    );
  }

  /** The registered actions and which need a checker now. Declared before `:id`. */
  @Get('actions')
  @RequirePermissions(APPROVAL_READ_PERMISSION)
  listActions(): ApprovalActionsResponse {
    return { items: this.actions.execute() };
  }

  @Get(':id')
  @RequirePermissions(APPROVAL_READ_PERMISSION)
  async detail(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<ApprovalResponse> {
    return toApprovalResponse(await this.getOne.execute(id, readerOf(user)));
  }

  @Post(':id/decide')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(APPROVAL_READ_PERMISSION)
  async decideOne(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: DecideApprovalDto,
    @Req() req: Request,
  ): Promise<ApprovalResponse> {
    const reader = readerOf(user);
    const decided = await this.decide.execute({
      approvalId: id,
      // From the token. There is no DTO field through which a checker could arrive.
      checkerUserId: user.userId,
      checkerPermissions: reader.permissions,
      decision: body.decision,
      reason: body.reason ?? null,
      ip: req.ip ?? null,
    });
    return toApprovalResponse(toApprovalView(decided, reader, new Date()));
  }
}

function readerOf(user: AuthenticatedPrincipal): ApprovalReader {
  return { userId: user.userId, permissions: user.permissions ?? [] };
}
