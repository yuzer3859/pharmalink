import { Inject, Injectable } from '@nestjs/common';
import { OrdersErrors } from '../../domain/errors';
import {
  IOrderRepository,
  OrderLineSnapshot,
  ORDER_REPOSITORY,
  OrderSnapshot,
  OrderStatusHistoryEntrySnapshot,
} from '../../domain/repositories/order.repository';

export interface GetOrderInput {
  orderId: string;
  customerUserId: string;
}

export interface OrderDetail {
  order: OrderSnapshot;
  lines: OrderLineSnapshot[];
  statusHistory: OrderStatusHistoryEntrySnapshot[];
}

/**
 * `GET /orders/:id` (module-06 `06-orders-spec.md` §9.3, BR-ORD-07) — detail view including its
 * `OrderLine`s and full `OrderStatusHistory[]` ledger (§3.8). Ownership is enforced by comparing
 * `Order.customerUserId` against the caller — a missing order and an order owned by a different
 * customer both resolve to the same `ORDER_NOT_FOUND` (no existence leakage across customers,
 * Step 7, identical discipline to module-05's `GetPrescriptionQuery`).
 */
@Injectable()
export class GetOrderQuery {
  constructor(@Inject(ORDER_REPOSITORY) private readonly orders: IOrderRepository) {}

  async execute(input: GetOrderInput): Promise<OrderDetail> {
    const order = await this.orders.findById(input.orderId);
    if (!order || order.customerUserId !== input.customerUserId) {
      throw OrdersErrors.orderNotFound();
    }

    const [lines, statusHistory] = await Promise.all([
      this.orders.findLinesByOrderId(order.id),
      this.orders.findStatusHistory(order.id),
    ]);

    return { order, lines, statusHistory };
  }
}
