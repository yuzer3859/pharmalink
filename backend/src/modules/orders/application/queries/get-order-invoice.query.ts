import { Inject, Injectable } from '@nestjs/common';
import { OrdersErrors } from '../../domain/errors';
import {
  InvoiceSnapshot,
  IOrderRepository,
  ORDER_REPOSITORY,
} from '../../domain/repositories/order.repository';

export interface GetOrderInvoiceInput {
  orderId: string;
  customerUserId: string;
}

/**
 * `GET /orders/:id/invoice` (module-06 `06-orders-spec.md` §9.3, §3.9, BR-ORD-11) — the data-only
 * `Invoice` row (`totals` JSON snapshot, `pdfRef` always `null` in Slice 1, §0.2). Ownership is
 * enforced the same way as `GetOrderQuery` (§7, no existence leakage). A missing invoice row on
 * an owned order (should not happen post-placement, §3.9/§3.11 invariant 2, but defensively
 * checked rather than assumed) reuses the generic `notFound` — it is not itself an order-scoped
 * lookup miss.
 */
@Injectable()
export class GetOrderInvoiceQuery {
  constructor(@Inject(ORDER_REPOSITORY) private readonly orders: IOrderRepository) {}

  async execute(input: GetOrderInvoiceInput): Promise<InvoiceSnapshot> {
    const order = await this.orders.findById(input.orderId);
    if (!order || order.customerUserId !== input.customerUserId) {
      throw OrdersErrors.orderNotFound();
    }

    const invoice = await this.orders.findInvoiceByOrderId(order.id);
    if (!invoice) {
      throw OrdersErrors.notFound('Invoice not found for this order.');
    }
    return invoice;
  }
}
