import { Inject, Injectable } from '@nestjs/common';
import {
  IInventoryPort,
  INVENTORY_PORT,
} from '../../../pharmacy-inventory/application/ports/inbound/inventory.port';
import { OrdersErrors } from '../../domain/errors';
import { OrderStatus } from '../../domain/enums';
import {
  IOrderRepository,
  ORDER_REPOSITORY,
  OrderSnapshot,
} from '../../domain/repositories/order.repository';
import { CancellationPolicy } from '../../domain/services/cancellation-policy';
import { OrderStatusPolicy } from '../../domain/services/order-status-policy';
import { OrderCancellationWorkflow } from '../services/order-cancellation.workflow';

export interface CancelOrderInput {
  orderId: string;
  customerUserId: string;
  reason: string;
}

/**
 * `POST /orders/:id/cancel` (module-06 `06-orders-spec.md` §9.3, §3.5, §8, BR-ORD-08). Ownership
 * is enforced identically to `GetOrderQuery` (§7, no existence leakage — `ORDER_NOT_FOUND` covers
 * both "doesn't exist" and "belongs to another customer"). `CancellationPolicy` is the sole
 * authority on *whether* cancellation is allowed for the order's current status (§3.5);
 * `OrderStatusPolicy` then validates the resulting `-> CANCELLED` transition itself is legal
 * (§3.11 invariant 3).
 *
 * The cancellation itself is `OrderCancellationWorkflow` (Work 55): the customer's intent is
 * persisted before Module 04 is touched, the order's reservations are released all-or-nothing, the
 * order is cancelled (status, history, audit, outbox — one Serializable transaction), and only then
 * is the coupon reversed. Any step the request cannot finish is completed by
 * `OrderCancellationReconciler`; a permanent failure is flagged for an operator.
 *
 * Responses:
 *  - the order (200) once it is `CANCELLED` — even if the coupon reversal is still pending, since
 *    the cancellation itself has happened;
 *  - `CANCELLATION_NOT_ALLOWED` (422) for a non-cancellable status, or when any reservation has
 *    already been dispatched (`MarkReadyCommand` dispatches before moving the order to `READY`).
 *    A read-only pre-check answers the plain case without any write; Module 04's batch release is
 *    the authority under a race, and its rejection leaves the order and its stock unchanged;
 *  - `DEPENDENCY_UNAVAILABLE` (503, `cancellation: PENDING`) when the intent is recorded but a
 *    transient failure (or a concurrent executor) left it unfinished — it completes automatically;
 *  - `CONFLICT` (409, `cancellation: NEEDS_ATTENTION`) when a permanent failure stopped it before the
 *    order was cancelled — the order and its stock are unchanged and the request awaits an operator.
 */
@Injectable()
export class CancelOrderCommand {
  constructor(
    @Inject(ORDER_REPOSITORY) private readonly orders: IOrderRepository,
    @Inject(INVENTORY_PORT) private readonly inventory: IInventoryPort,
    private readonly workflow: OrderCancellationWorkflow,
  ) {}

  async execute(input: CancelOrderInput): Promise<OrderSnapshot> {
    const order = await this.orders.findById(input.orderId);
    if (!order || order.customerUserId !== input.customerUserId) {
      throw OrdersErrors.orderNotFound();
    }
    CancellationPolicy.assertCanCancel(order.status);
    OrderStatusPolicy.assertValidTransition(order.status, OrderStatus.CANCELLED);

    if (await this.anyReservationDispatched(order.id)) {
      throw OrdersErrors.cancellationNotAllowed(order.status);
    }

    const outcome = await this.workflow.start({
      orderId: order.id,
      customerUserId: input.customerUserId,
      reason: input.reason,
    });
    if (outcome === 'REJECTED') {
      throw OrdersErrors.cancellationNotAllowed(order.status);
    }
    const after = (await this.orders.findById(order.id)) as OrderSnapshot;
    if (after.status === OrderStatus.CANCELLED) {
      return after;
    }
    throw outcome === 'ATTENTION' ? OrdersErrors.cancellationNeedsAttention() : OrdersErrors.cancellationPending();
  }

  /**
   * Read-only early answer: is any of the order's reservations already dispatched? Not a safeguard —
   * a dispatch can commit right after it — only a way to refuse the common case without persisting
   * anything. Any read failure just defers to the workflow, whose Module 04 batch is authoritative.
   */
  private async anyReservationDispatched(orderId: string): Promise<boolean> {
    const lines = await this.orders.findLinesByOrderId(orderId);
    const reservationIds = [...new Set(lines.map((l) => l.reservationId).filter((id): id is string => id !== null))];
    try {
      const views = await Promise.all(reservationIds.map((id) => this.inventory.getReservationFulfillment(id)));
      return views.some((v) => v.dispatched);
    } catch {
      return false;
    }
  }
}
