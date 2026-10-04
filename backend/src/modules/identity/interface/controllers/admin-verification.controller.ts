import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { RequirePermissions } from '../../../../shared/rbac/permissions.decorator';
import { AuthenticatedPrincipal } from '../../../../shared/rbac/rbac.types';
import { ApproveVerificationCommand } from '../../application/commands/approve-verification.command';
import { RejectVerificationCommand } from '../../application/commands/reject-verification.command';
import { ListVerificationQueueQuery } from '../../application/queries/list-verification-queue.query';
import { CurrentUser } from '../decorators/current-user.decorator';
import { ApproveVerificationDto, RejectVerificationDto } from '../dtos/verification.dto';

/**
 * Admin verification queue (module-01 §11.7). Reading the queue and deciding on a request are
 * separate permissions, matching §9.4's separation of duties.
 */
@Controller('admin/verification')
export class AdminVerificationController {
  constructor(
    private readonly listQueue: ListVerificationQueueQuery,
    private readonly approveVerification: ApproveVerificationCommand,
    private readonly rejectVerification: RejectVerificationCommand,
  ) {}

  @Get('queue')
  @RequirePermissions('verification:queue:read')
  queue(@Query('page') page?: string, @Query('size') size?: string) {
    return this.listQueue.execute(
      page ? Number(page) : undefined,
      size ? Number(size) : undefined,
    );
  }

  @Post(':id/approve')
  @RequirePermissions('provider:verify:any')
  @HttpCode(HttpStatus.NO_CONTENT)
  async approve(
    @CurrentUser() reviewer: AuthenticatedPrincipal,
    @Param('id') requestId: string,
    @Body() dto: ApproveVerificationDto,
    @Req() req: Request,
  ): Promise<void> {
    await this.approveVerification.execute({
      requestId,
      reviewerId: reviewer.userId,
      expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : null,
      ip: req.ip ?? null,
    });
  }

  @Post(':id/reject')
  @RequirePermissions('provider:verify:any')
  @HttpCode(HttpStatus.NO_CONTENT)
  async reject(
    @CurrentUser() reviewer: AuthenticatedPrincipal,
    @Param('id') requestId: string,
    @Body() dto: RejectVerificationDto,
    @Req() req: Request,
  ): Promise<void> {
    await this.rejectVerification.execute({
      requestId,
      reviewerId: reviewer.userId,
      reason: dto.reason,
      ip: req.ip ?? null,
    });
  }
}
