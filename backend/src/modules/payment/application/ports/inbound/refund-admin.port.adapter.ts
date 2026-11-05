import { Inject, Injectable } from '@nestjs/common';
import { CONFIG_PORT, IConfigPort } from '../../../../../shared/config/config.port';
import { RefundDestination } from '../../../domain/enums';
import { IPaymentRepository, PAYMENT_REPOSITORY } from '../../../domain/repositories/payment.repository';
import { IRefundRepository, REFUND_REPOSITORY } from '../../../domain/repositories/refund.repository';
import { RefundInitiator, RefundPaymentCommand } from '../../commands/refund-payment.command';
import { highValueRefundThreshold, refundNeedsSecondApproval } from '../../support/high-value-refund-policy';
import {
  IRefundAdminPort,
  RefundAdminPreview,
  RefundAdminRequest,
  RefundAdminResult,
} from './refund-admin.port';

@Injectable()
export class RefundAdminPortAdapter implements IRefundAdminPort {
  constructor(
    private readonly refundCommand: RefundPaymentCommand,
    @Inject(PAYMENT_REPOSITORY) private readonly payments: IPaymentRepository,
    @Inject(REFUND_REPOSITORY) private readonly refunds: IRefundRepository,
    @Inject(CONFIG_PORT) private readonly config: IConfigPort,
  ) {}

  async preview(paymentId: string, amount?: number | null): Promise<RefundAdminPreview | null> {
    const payment = await this.payments.findById(paymentId);
    if (!payment) return null;
    const remaining = Math.max(0, payment.amount - (await this.refunds.totalRefundedForPayment(paymentId)));
    const effectiveAmount = amount === undefined || amount === null ? remaining : amount;
    return {
      paymentId,
      currency: payment.currency,
      effectiveAmount,
      threshold: highValueRefundThreshold(this.config),
      needsSecondApproval: refundNeedsSecondApproval(this.config, effectiveAmount),
    };
  }

  async refund(request: RefundAdminRequest): Promise<RefundAdminResult> {
    const result = await this.refundCommand.execute({
      paymentId: request.paymentId,
      amount: request.amount ?? null,
      reason: request.reason ?? null,
      destination: request.destination === 'WALLET' ? RefundDestination.WALLET : RefundDestination.ORIGINAL,
      idempotencyKey: request.idempotencyKey,
      initiator: RefundInitiator.MANUAL,
      actorUserId: request.actorUserId,
      actorPermissions: request.actorPermissions,
      makerCheckerApprovalId: request.makerCheckerApprovalId ?? null,
    });
    return {
      refundId: result.refundId,
      paymentId: result.paymentId,
      amount: result.amount,
      currency: result.currency,
      status: result.status,
    };
  }
}
