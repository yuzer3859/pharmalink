import { Inject, Injectable } from '@nestjs/common';
import { ApiException } from '../../../../shared/errors/api-exception';
import { ErrorCode } from '../../../../shared/errors/error-codes';
import {
  IPaymentAuthorizationPort,
  PAYMENT_AUTHORIZATION_PORT,
} from '../../../payment/application/ports/inbound/payment-authorization.port';
import { PaymentMethod } from '../../../payment/domain/enums';
import { OrderStatus } from '../../domain/enums';
import { OrdersErrors } from '../../domain/errors';
import { IOrderRepository, ORDER_REPOSITORY, OrderSnapshot } from '../../domain/repositories/order.repository';
import { PrepaidPaymentService } from '../services/prepaid-payment.service';
import { CheckoutPaymentResult, PrepaidPaymentInput, prepaidPaymentKey } from './checkout.command';

export interface PayOrderInput {
  orderId: string;
  customerUserId: string;
  payment: PrepaidPaymentInput;
}

export interface PayOrderResult {
  order: OrderSnapshot;
  payment: CheckoutPaymentResult;
}

/**
 * Work 129: `POST /orders/:id/pay`, the customer pays a prepaid order whose prescription the
 * pharmacist approved (verify before paying). It is checkout's own payment step, run later: the
 * same authorization key (`prepaidPaymentKey`), so a retry never opens a second payment, and the
 * same outcomes through `PrepaidPaymentService`. Authorized: the order is paid and goes to the
 * pharmacy. Declined: the order is cancelled and its stock released, as at checkout.
 *
 * Only the customer's own prepaid order, still awaiting payment, with an approved prescription.
 * Another customer's order reads as not found.
 */
@Injectable()
export class PayOrderCommand {
  constructor(
    @Inject(ORDER_REPOSITORY) private readonly orders: IOrderRepository,
    @Inject(PAYMENT_AUTHORIZATION_PORT) private readonly payments: IPaymentAuthorizationPort,
    private readonly prepaid: PrepaidPaymentService,
  ) {}

  async execute(input: PayOrderInput): Promise<PayOrderResult> {
    const order = await this.orders.findById(input.orderId);
    if (!order || order.customerUserId !== input.customerUserId) throw OrdersErrors.orderNotFound();
    if (order.isCod || order.status !== OrderStatus.PENDING_PAYMENT) {
      throw OrdersErrors.validation('This order is not waiting for a payment.');
    }
    if (order.rxReviewStatus !== 'APPROVED') {
      throw OrdersErrors.validation('You can pay once the pharmacist has approved your prescription.');
    }

    let authorized;
    try {
      authorized = await this.payments.authorize({
        customerUserId: input.customerUserId,
        orderId: order.id,
        method: input.payment.method as PaymentMethod,
        providerToken: input.payment.token ?? null,
        returnUrl: input.payment.returnUrl ?? null,
        idempotencyKey: prepaidPaymentKey(order.id),
      });
    } catch (err) {
      if (err instanceof ApiException && err.code === ErrorCode.PAYMENT_AUTH_FAILED) {
        await this.prepaid.onFailed({ orderId: order.id });
        const details = err.details && typeof err.details === 'object' ? (err.details as Record<string, unknown>) : {};
        throw new ApiException(err.code, err.message, { ...details, orderId: order.id });
      }
      throw err;
    }

    if (authorized.status === 'AUTHORIZED') {
      await this.prepaid.onAuthorized({ orderId: order.id, paymentId: authorized.paymentId });
    } else if (authorized.status === 'FAILED') {
      await this.prepaid.onFailed({ orderId: order.id });
    }
    return {
      order: (await this.orders.findById(order.id)) ?? order,
      payment: { paymentId: authorized.paymentId, status: authorized.status, providerRedirect: authorized.providerRedirect ?? null },
    };
  }
}
