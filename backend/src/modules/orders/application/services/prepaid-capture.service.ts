import { Inject, Injectable } from '@nestjs/common';
import { AppLogger } from '../../../../shared/logging/app-logger.service';
import {
  IPaymentAuthorizationPort,
  PAYMENT_AUTHORIZATION_PORT,
} from '../../../payment/application/ports/inbound/payment-authorization.port';
import { OrderStatus } from '../../domain/enums';
import { IOrderRepository, ORDER_REPOSITORY } from '../../domain/repositories/order.repository';

/** Order statuses at or after the hand-over to fulfilment, when the payment is captured (module-07 §11.3). */
export const CAPTURABLE_ORDER_STATUSES: readonly string[] = [
  OrderStatus.READY,
  OrderStatus.DISPATCHED,
  OrderStatus.DELIVERED,
  OrderStatus.COMPLETED,
];

export type CaptureOutcome = 'CAPTURED' | 'ALREADY_CAPTURED' | 'NOT_APPLICABLE';

/**
 * Work 96: capture at fulfilment (module-07 §11.3, "Orders OrderReady → capture"). When the
 * pharmacy marks a prepaid order ready, Module 07 captures its authorization: the money is
 * collected and the ledger's CAPTURE transaction accrues the provider payable that settlement pays
 * out. Before this Work nothing called capture (Phase 1 audit gap G2).
 *
 * Driven by the order's own `order.ready` event (`OrderReadyCaptureHandler`) and swept by
 * `PaymentCaptureReconciler` for any capture that failed. Idempotent end to end: Module 07 answers
 * an already-captured payment as a replay, and `orders.paymentCapturedAt` is written once.
 * COD orders, and orders without a payment, are not applicable.
 */
@Injectable()
export class PrepaidCaptureService {
  private readonly logger = new AppLogger();

  constructor(
    @Inject(ORDER_REPOSITORY) private readonly orders: IOrderRepository,
    @Inject(PAYMENT_AUTHORIZATION_PORT) private readonly payments: IPaymentAuthorizationPort,
  ) {
    this.logger.setContext(PrepaidCaptureService.name);
  }

  async capture(orderId: string): Promise<CaptureOutcome> {
    const order = await this.orders.findById(orderId);
    if (!order || order.isCod || !order.paymentId) return 'NOT_APPLICABLE';
    if (!CAPTURABLE_ORDER_STATUSES.includes(order.status)) return 'NOT_APPLICABLE';
    if (await this.orders.isPaymentCaptured(order.id)) return 'ALREADY_CAPTURED';

    const result = await this.payments.capture({ paymentId: order.paymentId, actorUserId: null });
    await this.orders.markPaymentCaptured(order.id, new Date());
    this.logger.log({ message: 'Prepaid order payment captured at fulfilment', orderId: order.id, paymentId: order.paymentId, replay: result.replay });
    return result.replay ? 'ALREADY_CAPTURED' : 'CAPTURED';
  }
}
