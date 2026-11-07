import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../../../shared/audit/audit.service';
import { AppLogger } from '../../../../shared/logging/app-logger.service';
import { OutboxService } from '../../../../shared/outbox/outbox.service';
import { IInventoryPort, INVENTORY_PORT } from '../../../pharmacy-inventory/application/ports/inbound/inventory.port';
import {
  IPaymentAuthorizationPort,
  PAYMENT_AUTHORIZATION_PORT,
} from '../../../payment/application/ports/inbound/payment-authorization.port';
import { OrderStatus } from '../../domain/enums';
import { orderPaidEvent } from '../../domain/events';
import { IOrderRepository, ORDER_REPOSITORY } from '../../domain/repositories/order.repository';
import { OrderStatusPolicy } from '../../domain/services/order-status-policy';
import { IUnitOfWork, UNIT_OF_WORK } from '../ports/unit-of-work.port';
import { runWithOrderRetry } from '../support/order-retry';
import { CancellationOutcome, OrderCancellationWorkflow } from './order-cancellation.workflow';

/** Cancellation reasons this service records (kept on the order and in its history). */
export const PREPAID_CANCEL_REASONS = {
  paymentFailed: 'payment-failed',
  reservationLost: 'reservation-expired-before-payment',
  paymentTimeout: 'payment-not-completed-in-time',
} as const;

export type AuthorizedOutcome = 'PAID' | 'ALREADY_PAID' | 'CANCELLED' | 'IGNORED';

/**
 * Work 95: checkout saga steps 7–8 for a prepaid order (module-06 §6), shared by the in-request
 * path (`CheckoutCommand`) and the asynchronous one (`PaymentOutcomeHandler`, for a redirect flow
 * whose result arrives by webhook). Every method is idempotent: the event for an outcome the
 * request already applied changes nothing.
 *
 * - **Authorized:** confirm the order's reservations (`HELD -> CONFIRMED`), then one Serializable
 *   transaction moves `PENDING_PAYMENT -> PAID`, records `orders.paymentId`, audits `ORDER_PAID`
 *   and writes `order.paid` carrying the payment. If a reservation can no longer be confirmed
 *   (its hold expired while the customer paid), the authorization is voided and the order
 *   cancelled: money is never held for an order that cannot be filled.
 * - **Failed:** the order is cancelled through `OrderCancellationWorkflow`, which releases the
 *   stock and reverses the coupon durably (resumed by its reconciler after a crash). This is the
 *   roadmap's "payment failure releases the stock reservation".
 * - **Late authorization** for an order no longer awaiting payment (cancelled or expired): the
 *   hold is voided.
 */
@Injectable()
export class PrepaidPaymentService {
  private readonly logger = new AppLogger();

  constructor(
    @Inject(ORDER_REPOSITORY) private readonly orders: IOrderRepository,
    @Inject(INVENTORY_PORT) private readonly inventory: IInventoryPort,
    @Inject(PAYMENT_AUTHORIZATION_PORT) private readonly payments: IPaymentAuthorizationPort,
    @Inject(UNIT_OF_WORK) private readonly uow: IUnitOfWork,
    private readonly cancellation: OrderCancellationWorkflow,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {
    this.logger.setContext(PrepaidPaymentService.name);
  }

  async onAuthorized(input: { orderId: string; paymentId: string }): Promise<AuthorizedOutcome> {
    const order = await this.orders.findById(input.orderId);
    if (!order || order.isCod) return 'IGNORED';
    if (order.paymentId === input.paymentId) return 'ALREADY_PAID';
    if (order.status !== OrderStatus.PENDING_PAYMENT) {
      await this.voidQuietly(input.paymentId, 'order-no-longer-awaiting-payment');
      return 'CANCELLED';
    }

    const lines = await this.orders.findLinesByOrderId(order.id);
    const reservationIds = [...new Set(lines.map((l) => l.reservationId).filter((id): id is string => id !== null))];
    try {
      for (const reservationId of reservationIds) {
        await this.inventory.confirm({ reservationId });
      }
    } catch (err) {
      this.logger.warn({
        message: 'A reservation could not be confirmed after payment; voiding and cancelling the order',
        orderId: order.id,
        error: err instanceof Error ? err.message : String(err),
      });
      await this.voidQuietly(input.paymentId, PREPAID_CANCEL_REASONS.reservationLost);
      await this.cancellation.start({
        orderId: order.id,
        customerUserId: order.customerUserId,
        reason: PREPAID_CANCEL_REASONS.reservationLost,
      });
      return 'CANCELLED';
    }

    const outcome = await runWithOrderRetry(this.uow, async (tx): Promise<AuthorizedOutcome | 'LOST'> => {
      const fresh = await this.orders.findById(order.id, tx);
      if (!fresh) return 'IGNORED';
      if (fresh.paymentId === input.paymentId) return 'ALREADY_PAID';
      if (fresh.status !== OrderStatus.PENDING_PAYMENT) return 'LOST';
      OrderStatusPolicy.assertValidTransition(fresh.status, OrderStatus.PAID);
      await this.orders.updateStatus(
        fresh.id,
        { status: OrderStatus.PAID, paymentId: input.paymentId },
        {
          fromStatus: fresh.status,
          toStatus: OrderStatus.PAID,
          event: 'PAYMENT_AUTHORIZED',
          actorUserId: null,
          actorRole: 'SYSTEM',
        },
        tx,
      );
      await this.audit.record(
        {
          actorUserId: null,
          action: 'ORDER_PAID',
          resourceType: 'Order',
          resourceId: fresh.id,
          context: { paymentId: input.paymentId, grandTotal: fresh.grandTotal },
        },
        tx,
      );
      await this.outbox.write(orderPaidEvent({ orderId: fresh.id, paymentId: input.paymentId }), tx as never);
      return 'PAID';
    });

    if (outcome === 'LOST') {
      // Cancelled (or expired) between the read above and this transaction: release the hold.
      await this.voidQuietly(input.paymentId, 'order-no-longer-awaiting-payment');
      return 'CANCELLED';
    }
    return outcome;
  }

  async onFailed(input: { orderId: string }): Promise<CancellationOutcome | 'IGNORED'> {
    return this.cancelUnpaid(input.orderId, PREPAID_CANCEL_REASONS.paymentFailed);
  }

  /** Cancels a prepaid order still awaiting payment (a decline, or the payment window passing). */
  async cancelUnpaid(orderId: string, reason: string): Promise<CancellationOutcome | 'IGNORED'> {
    const order = await this.orders.findById(orderId);
    if (!order || order.isCod || order.status !== OrderStatus.PENDING_PAYMENT) return 'IGNORED';
    return this.cancellation.start({ orderId: order.id, customerUserId: order.customerUserId, reason });
  }

  /**
   * Releases an authorization hold. A failure is logged loudly, never thrown: the order outcome
   * above must still be recorded, and the payment stays `AUTHORIZED`, visible to finance in
   * reconciliation, rather than being hidden.
   */
  private async voidQuietly(paymentId: string, reason: string): Promise<void> {
    try {
      await this.payments.void({ paymentId, actorUserId: null, reason });
    } catch (err) {
      this.logger.error({
        message: 'Could not void the authorization of a prepaid order that will not be filled; the payment stays AUTHORIZED for finance to release',
        paymentId,
        reason,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
