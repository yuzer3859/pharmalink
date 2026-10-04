import { Inject, Injectable } from '@nestjs/common';
import { RefundDestination, RefundStatus, RefundType } from '../../domain/enums';
import { PaymentErrors } from '../../domain/errors';
import {
  IPaymentRepository,
  PAYMENT_REPOSITORY,
} from '../../domain/repositories/payment.repository';
import {
  IRefundRepository,
  REFUND_REPOSITORY,
} from '../../domain/repositories/refund.repository';

/**
 * The safe projection of a refund (§9.3 `GET /payments/{id}/refunds`).
 *
 * What is **deliberately absent**:
 *
 *  - the payment's `providerToken` and any instrument detail — a refund needs none of it, and it
 *    is not the caller's business (the same allow-list discipline `PaymentView` applies);
 *  - `idempotencyKey` — the caller supplied it; echoing it back lets one leak into a shared log;
 *  - ledger account ids and the raw webhook payload — internal bookkeeping (§12);
 *  - `approvedBy` — the identity of the finance officer who approved a refund belongs in the audit
 *    trail (§13), which is read under `audit:read:any`, not in a customer-readable projection.
 *
 * `providerRef` *is* included: it is the reference a customer quotes to support and a gateway shows
 * on a statement, and it is not a credential. `currency` comes from the payment, because §7's
 * `refunds` deliberately has no currency column (see `RefundProps`).
 */
export interface RefundView {
  refundId: string;
  paymentId: string;
  amount: number;
  currency: string;
  type: RefundType;
  destination: RefundDestination;
  status: RefundStatus;
  providerRef: string | null;
  reason: string | null;
  createdAt: Date;
  completedAt: Date | null;
}

export interface ListPaymentRefundsInput {
  paymentId: string;
  /**
   * Resolved from the access token by the caller. When present the payment must belong to this
   * customer; when omitted the caller has already been authorized to read any payment (a finance
   * or admin route), so no ownership filter applies. Mirrors `GetPaymentInput`.
   */
  customerUserId?: string | null;
}

export interface PaymentRefundsView {
  paymentId: string;
  currency: string;
  /** The captured amount refunds are measured against. */
  capturedAmount: number;
  /** Σ of every refund that counts against the total (everything except `FAILED`). */
  totalRefunded: number;
  /**
   * `capturedAmount - totalRefunded` (BRULE-24). Reported explicitly because it is the number a
   * client needs before requesting a partial refund — and because when §6's missing
   * `PARTIALLY_REFUNDED -> REFUNDED` edge leaves a fully-refunded payment showing
   * `PARTIALLY_REFUNDED`, this zero is what tells the truth (see `RefundPaymentCommand`).
   */
  remainingRefundable: number;
  refunds: RefundView[];
}

/**
 * `GET /payments/{id}/refunds` (§9.3). The application query the HTTP task will read through — the
 * transport itself is deliberately not built here (§19 of this task's brief keeps transport
 * separate), but the read exists so that controller never has to reach into Prisma directly, which
 * no module in this codebase does.
 *
 * **Ownership is enforced here, not in a controller.** A payment that does not exist and a payment
 * belonging to someone else resolve to the same `NOT_FOUND`, so this cannot be used to probe for
 * other customers' payments — the identical no-existence-leakage discipline `GetPaymentQuery` and
 * `GetOrderQuery` apply. Keeping the rule here means every future caller inherits it.
 */
@Injectable()
export class ListPaymentRefundsQuery {
  constructor(
    @Inject(PAYMENT_REPOSITORY) private readonly payments: IPaymentRepository,
    @Inject(REFUND_REPOSITORY) private readonly refunds: IRefundRepository,
  ) {}

  async execute(input: ListPaymentRefundsInput): Promise<PaymentRefundsView> {
    if (!input.paymentId || input.paymentId.trim().length === 0) {
      throw PaymentErrors.validation('paymentId is required.', { field: 'paymentId' });
    }

    const payment = await this.payments.findById(input.paymentId);
    // One error for both cases, deliberately: distinguishing them would confirm that another
    // customer's payment exists.
    if (!payment || (input.customerUserId && payment.customerUserId !== input.customerUserId)) {
      throw PaymentErrors.notFound('Payment not found.', { paymentId: input.paymentId });
    }

    const rows = await this.refunds.findByPaymentId(payment.id);
    const totalRefunded = await this.refunds.totalRefundedForPayment(payment.id);

    return {
      paymentId: payment.id,
      currency: payment.currency,
      capturedAmount: payment.amount,
      totalRefunded,
      remainingRefundable: Math.max(payment.amount - totalRefunded, 0),
      refunds: rows.map((refund) => ({
        refundId: refund.id,
        paymentId: refund.paymentId,
        amount: refund.amount,
        currency: payment.currency,
        type: refund.type,
        destination: refund.destination,
        status: refund.status,
        providerRef: refund.providerRef,
        reason: refund.reason,
        createdAt: refund.createdAt,
        completedAt: refund.completedAt,
      })),
    };
  }
}
