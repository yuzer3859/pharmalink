import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { RequirePermissions } from '../../../../shared/rbac/permissions.decorator';
import { AuthenticatedPrincipal } from '../../../../shared/rbac/rbac.types';
import { CurrentUser } from '../../../identity/interface/decorators/current-user.decorator';
import {
  Actor,
  DISPUTE_MANAGE_PERMISSION,
  DISPUTE_OWN_PERMISSION,
  DisputeService,
  DisputeView,
} from '../../application/disputes/dispute.service';
import { RequireIdempotencyKey } from '../decorators/idempotency-key.decorator';
import {
  AdminDisputeMessageDto,
  AdminOpenDisputeDto,
  DisputeMessageDto,
  ListDisputesDto,
  OpenDisputeDto,
  ResolveDisputeDto,
  UpdateDisputeDto,
} from '../dtos/dispute.dto';
import type { DisputeMessageRow } from '../../infrastructure/persistence/prisma-dispute.repository';

const actorOf = (user: AuthenticatedPrincipal, req: Request): Actor => ({
  userId: user.userId,
  permissions: user.permissions ?? [],
  ip: req.ip ?? null,
});

function caseResponse(view: DisputeView, forCustomer = false) {
  const c = view.case;
  return {
    id: c.id,
    caseNumber: c.caseNumber,
    type: c.type,
    orderId: c.transactionId,
    subject: c.subject,
    description: c.description,
    status: c.status,
    priority: c.priority,
    openedAt: c.openedAt.toISOString(),
    slaDueAt: c.slaDueAt.toISOString(),
    resolvedAt: c.resolvedAt?.toISOString() ?? null,
    closedAt: c.closedAt?.toISOString() ?? null,
    overdue: view.overdue,
    // What the customer is told: the remedy, not who decided it or the internal notes.
    resolution: forCustomer
      ? c.resolution
        ? { action: (c.resolution as { action?: string }).action ?? null }
        : null
      : c.resolution,
    ...(forCustomer
      ? {}
      : {
          complainantUserId: c.complainantUserId,
          openedByUserId: c.openedByUserId,
          assignedAdminId: c.assignedAdminId,
          pendingApprovalId: c.pendingApprovalId,
        }),
  };
}

const messageResponse = (m: DisputeMessageRow, forCustomer = false) => ({
  id: m.id,
  senderRole: m.senderRole,
  body: m.body,
  createdAt: m.createdAt.toISOString(),
  ...(forCustomer ? {} : { senderUserId: m.senderUserId, internal: m.internal }),
});

/**
 * Administrators' dispute desk (Work 86; module-16 §9.6 `CRUD /admin/disputes`, `.../message`,
 * `.../resolve`; backend/docs/disputes.md). `dispute:manage:any` — ADMIN and FINANCE_OFFICER.
 */
@Controller('admin/disputes')
@RequirePermissions(DISPUTE_MANAGE_PERMISSION)
export class AdminDisputesController {
  constructor(private readonly disputes: DisputeService) {}

  @Get()
  async list(@CurrentUser() user: AuthenticatedPrincipal, @Query() q: ListDisputesDto) {
    const page = await this.disputes.list(
      {
        status: q.status,
        type: q.type,
        priority: q.priority,
        transactionId: q.orderId,
        assignedAdminId: q.mine === 'true' ? user.userId : undefined,
        overdueAt: q.overdue === 'true' ? new Date() : undefined,
      },
      q.page ?? 1,
      q.size ?? 20,
    );
    return { ...page, items: page.items.map((v) => caseResponse(v)) };
  }

  @Post()
  async open(@CurrentUser() user: AuthenticatedPrincipal, @Body() body: AdminOpenDisputeDto, @Req() req: Request) {
    return caseResponse(await this.disputes.open(body, actorOf(user, req), true));
  }

  @Get(':id')
  async detail(@Param('id', new ParseUUIDPipe()) id: string) {
    const { view, messages } = await this.disputes.getForAdmin(id);
    return { ...caseResponse(view), messages: messages.map((m) => messageResponse(m)) };
  }

  @Patch(':id')
  async update(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: UpdateDisputeDto,
    @Req() req: Request,
  ) {
    return caseResponse(
      await this.disputes.update(id, actorOf(user, req), {
        status: body.status,
        priority: body.priority,
        assignedAdminId: body.assignToMe === undefined ? undefined : body.assignToMe ? user.userId : null,
        reason: body.reason ?? null,
      }),
    );
  }

  @Post(':id/messages')
  async message(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: AdminDisputeMessageDto,
    @Req() req: Request,
  ) {
    return messageResponse(await this.disputes.addMessage(id, actorOf(user, req), true, body.body, body.internal ?? false));
  }

  @Post(':id/resolve')
  @HttpCode(HttpStatus.OK)
  async resolve(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: ResolveDisputeDto,
    @RequireIdempotencyKey() idempotencyKey: string,
    @Req() req: Request,
  ) {
    return caseResponse(
      await this.disputes.resolve(id, actorOf(user, req), {
        action: body.action,
        notes: body.notes,
        amount: body.amount ?? null,
        destination: body.destination,
        idempotencyKey,
      }),
    );
  }
}

/**
 * A customer's own disputes (Work 86, `dispute:create:own`): open one about their order, follow it,
 * and write to support. Internal notes and who decided are never shown.
 */
@Controller('disputes')
@RequirePermissions(DISPUTE_OWN_PERMISSION)
export class CustomerDisputesController {
  constructor(private readonly disputes: DisputeService) {}

  @Get()
  async mine(@CurrentUser() user: AuthenticatedPrincipal, @Query() q: ListDisputesDto) {
    const page = await this.disputes.list({ complainantUserId: user.userId, status: q.status }, q.page ?? 1, q.size ?? 20);
    return { ...page, items: page.items.map((v) => caseResponse(v, true)) };
  }

  @Post()
  async open(@CurrentUser() user: AuthenticatedPrincipal, @Body() body: OpenDisputeDto, @Req() req: Request) {
    return caseResponse(await this.disputes.open(body, actorOf(user, req), false), true);
  }

  @Get(':id')
  async detail(@CurrentUser() user: AuthenticatedPrincipal, @Param('id', new ParseUUIDPipe()) id: string) {
    const { view, messages } = await this.disputes.getForCustomer(id, user.userId);
    return { ...caseResponse(view, true), messages: messages.map((m) => messageResponse(m, true)) };
  }

  @Post(':id/messages')
  async message(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: DisputeMessageDto,
    @Req() req: Request,
  ) {
    return messageResponse(await this.disputes.addMessage(id, actorOf(user, req), false, body.body, false), true);
  }
}
