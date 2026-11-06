import { Body, Controller, HttpStatus, Inject, Param, ParseUUIDPipe, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { RequirePermissions } from '../../../../shared/rbac/permissions.decorator';
import { AuthenticatedPrincipal } from '../../../../shared/rbac/rbac.types';
import { CurrentUser } from '../../../identity/interface/decorators/current-user.decorator';
import {
  FINANCE_REFUND_ADMIN_PERMISSION,
  IRefundAdminPort,
  REFUND_ADMIN_PORT,
} from '../../../payment/application/ports/inbound/refund-admin.port';
import { toApprovalView } from '../../application/maker-checker/approval-queries';
import { MakerCheckerGate } from '../../application/maker-checker/maker-checker-gate.service';
import { AdminErrors } from '../../domain/errors';
import { REFUND_HIGH_VALUE_ACTION } from '../../infrastructure/maker-checker/refund.actions';
import { RequireIdempotencyKey } from '../decorators/idempotency-key.decorator';
import { toApprovalResponse } from '../dtos/approval.response';
import { AdminRefundDto } from '../dtos/admin-refund.dto';

/**
 * `POST /admin/finance/payments/{id}/refunds` (Work 84): a manual refund from the finance portal.
 * At or below `approvals.highValueRefundThreshold` it runs at once (`200 EXECUTED`); above it, a
 * pending request for a second finance officer (`202 MAKER_CHECKER_PENDING`, §11.2). Module 07's
 * own `POST /payments/{id}/refunds` refuses a single-actor refund above the threshold, so this is
 * the only way one can be made.
 */
@Controller('admin/finance/payments')
export class AdminRefundController {
  constructor(
    private readonly gate: MakerCheckerGate,
    @Inject(REFUND_ADMIN_PORT) private readonly refunds: IRefundAdminPort,
  ) {}

  @Post(':id/refunds')
  @RequirePermissions(FINANCE_REFUND_ADMIN_PERMISSION)
  async refund(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Param('id', new ParseUUIDPipe()) paymentId: string,
    @Body() body: AdminRefundDto,
    @RequireIdempotencyKey() idempotencyKey: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const preview = await this.refunds.preview(paymentId, body.amount ?? null);
    if (!preview) throw AdminErrors.paymentNotFound();
    const result = await this.gate.submit({
      actionType: REFUND_HIGH_VALUE_ACTION,
      payload: {
        paymentId,
        amount: body.amount ?? null,
        reason: body.reason?.trim() || null,
        destination: body.destination ?? 'ORIGINAL',
        // Display-only for the checker; the executor and Module 07 decide the real amount.
        effectiveAmount: preview.effectiveAmount,
        currency: preview.currency,
      },
      makerUserId: user.userId,
      makerPermissions: user.permissions ?? [],
      idempotencyKey,
      reason: body.reason ?? null,
      ip: req.ip ?? null,
    });
    if (result.outcome === 'EXECUTED') {
      res.status(HttpStatus.OK);
      return { outcome: 'EXECUTED', result: result.result };
    }
    res.status(HttpStatus.ACCEPTED);
    return {
      outcome: 'MAKER_CHECKER_PENDING',
      threshold: preview.threshold,
      approval: toApprovalResponse(
        toApprovalView(result.approval, { userId: user.userId, permissions: user.permissions ?? [] }, new Date()),
      ),
    };
  }
}
