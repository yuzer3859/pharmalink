import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { ApprovalEntityType } from '@prisma/client';
import {
  FINANCE_REFUND_ADMIN_PERMISSION,
  IRefundAdminPort,
  REFUND_ADMIN_PORT,
} from '../../../payment/application/ports/inbound/refund-admin.port';
import { AdminErrors } from '../../domain/errors';
import { MakerCheckerActionRegistry } from '../../domain/maker-checker/maker-checker-action';
import { DisputeService } from '../../application/disputes/dispute.service';

/** Work 84's action type (also `MAKER_CHECKER_ACTION_TYPES`). */
export const REFUND_HIGH_VALUE_ACTION = 'REFUND_HIGH_VALUE';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface RefundPayload {
  paymentId: string;
  amount: number | null;
  reason: string | null;
  destination: 'ORIGINAL' | 'WALLET';
}

function parse(payload: Record<string, unknown>): RefundPayload {
  const paymentId = payload.paymentId;
  if (typeof paymentId !== 'string' || !UUID.test(paymentId)) {
    throw AdminErrors.validation('paymentId must be a UUID.', { field: 'paymentId' });
  }
  const amount = payload.amount ?? null;
  if (amount !== null && (typeof amount !== 'number' || !Number.isInteger(amount) || amount <= 0)) {
    throw AdminErrors.validation('amount must be a positive whole number of santim.', { field: 'amount' });
  }
  const destination = payload.destination === 'WALLET' ? 'WALLET' : 'ORIGINAL';
  const reason = typeof payload.reason === 'string' && payload.reason.trim() ? payload.reason.trim() : null;
  return { paymentId, amount: amount as number | null, reason, destination };
}

/**
 * High-value manual refunds as a maker-checker action (Work 84, module-16 §11.2). Only a refund above
 * `approvals.highValueRefundThreshold` waits for a second officer (`needsApproval`); a smaller one runs
 * at once. Either way the refund is Module 07's `RefundPaymentCommand` behind `REFUND_ADMIN_PORT`.
 */
@Injectable()
export class RefundActions implements OnModuleInit {
  constructor(
    private readonly registry: MakerCheckerActionRegistry,
    @Inject(REFUND_ADMIN_PORT) private readonly refunds: IRefundAdminPort,
    private readonly disputes: DisputeService,
  ) {}

  onModuleInit(): void {
    this.registry.register({
      type: REFUND_HIGH_VALUE_ACTION,
      entityType: ApprovalEntityType.REFUND,
      requiredPermission: FINANCE_REFUND_ADMIN_PERMISSION,
      describe: (payload) => {
        const p = parse(payload);
        const shown =
          typeof payload.effectiveAmount === 'number'
            ? `${(payload.effectiveAmount / 100).toFixed(2)} ${typeof payload.currency === 'string' ? payload.currency : ''}`.trim()
            : p.amount === null
              ? 'everything still refundable'
              : `${(p.amount / 100).toFixed(2)}`;
        return { entityId: p.paymentId, summary: `Refund ${shown} on payment ${p.paymentId}` };
      },
      needsApproval: async (payload) => {
        const p = parse(payload);
        const preview = await this.refunds.preview(p.paymentId, p.amount);
        return preview?.needsSecondApproval ?? false;
      },
      execute: async (payload, ctx) => {
        const p = parse(payload);
        const refund = await this.refunds.refund({
          paymentId: p.paymentId,
          amount: p.amount,
          reason: p.reason,
          destination: p.destination,
          idempotencyKey: ctx.idempotencyKey,
          actorUserId: ctx.actorUserId,
          actorPermissions: ctx.actorPermissions,
          makerCheckerApprovalId: ctx.approvalId,
        });
        // Work 86: a refund ordered as a dispute's resolution completes that case.
        if (typeof payload.disputeCaseId === 'string' && ctx.approvalId) {
          await this.disputes.completeRefund(payload.disputeCaseId, ctx.approvalId, ctx.actorUserId, { ...refund });
        }
        return { ...refund };
      },
    });
  }
}
