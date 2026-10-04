import { Inject, Injectable } from '@nestjs/common';
import { PaymentMethod, PaymentStatus } from '../../domain/enums';
import { PaymentErrors } from '../../domain/errors';
import {
  IPaymentRepository,
  PAYMENT_REPOSITORY,
} from '../../domain/repositories/payment.repository';

/**
 * The customer-safe projection of a payment (§9.1 `GET /payments/{id}` → "status + refs").
 *
 * What is **deliberately absent** matters more than what is present:
 *
 *  - `providerToken` — the gateway token stands in for the customer's instrument. Echoing it back
 *    over HTTP would put a payment credential in browser history, logs and caches for no reason:
 *    nothing a client does with this response needs it.
 *  - the raw webhook payload, ledger account ids and reconciliation metadata — internal
 *    bookkeeping, and §12's rule is that provider payloads live only in `provider_webhooks`.
 *  - `idempotencyKey` — the caller supplied it; returning it lets one leak into a shared log.
 *
 * `providerRef` *is* included: it is the reference a customer quotes to support and a gateway
 * shows on a statement, and it is not a credential. `failureReason` is already sanitized before
 * it is ever persisted (Task 2's `sanitizeProviderFailureReason`), so it is safe to surface.
 */
export interface PaymentView {
  paymentId: string;
  orderId: string;
  amount: number;
  currency: string;
  method: PaymentMethod;
  status: PaymentStatus;
  provider: string | null;
  providerRef: string | null;
  authorizedAt: Date | null;
  capturedAt: Date | null;
  failureReason: string | null;
  createdAt: Date;
}

export interface GetPaymentInput {
  paymentId: string;
  /**
   * Resolved from the access token by the caller. When present the payment must belong to this
   * customer; when omitted the caller has already been authorized to read any payment (a finance
   * or admin route), so no ownership filter applies.
   */
  customerUserId?: string | null;
}

/**
 * `GET /payments/{id}` (§9.1). The application query the HTTP layer reads through — added by the
 * HTTP task, which found no existing payment read: Tasks 1–5 built only commands, so a controller
 * would otherwise have had to reach into Prisma directly, which no module in this codebase does.
 *
 * **Ownership is enforced here, not in the controller.** A payment that does not exist and a
 * payment belonging to someone else resolve to the same `NOT_FOUND`, so this endpoint cannot be
 * used to probe for other customers' payments — the identical no-existence-leakage discipline
 * `GetOrderQuery` applies in Module 06, and `AuthorizePaymentCommand` applies to orders. Keeping
 * the rule here rather than in the controller means every future caller inherits it.
 */
@Injectable()
export class GetPaymentQuery {
  constructor(@Inject(PAYMENT_REPOSITORY) private readonly payments: IPaymentRepository) {}

  async execute(input: GetPaymentInput): Promise<PaymentView> {
    if (!input.paymentId || input.paymentId.trim().length === 0) {
      throw PaymentErrors.validation('paymentId is required.', { field: 'paymentId' });
    }

    const payment = await this.payments.findById(input.paymentId);
    // One error for both cases, deliberately: distinguishing them would confirm that another
    // customer's payment exists.
    if (
      !payment ||
      (input.customerUserId && payment.customerUserId !== input.customerUserId)
    ) {
      throw PaymentErrors.notFound('Payment not found.', { paymentId: input.paymentId });
    }

    return {
      paymentId: payment.id,
      orderId: payment.orderId,
      amount: payment.amount,
      currency: payment.currency,
      method: payment.method,
      status: payment.status,
      provider: payment.provider,
      providerRef: payment.providerRef,
      authorizedAt: payment.authorizedAt,
      capturedAt: payment.capturedAt,
      failureReason: payment.failureReason,
      createdAt: payment.createdAt,
    };
  }
}
