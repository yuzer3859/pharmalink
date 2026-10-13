import { Inject, Injectable } from '@nestjs/common';
import {
  IOrderOperationsReadPort,
  ORDER_OPERATIONS_READ_PORT,
  OrderOperationsDetail,
  OrderOperationsFilter,
  OrderOperationsPage,
} from '../../../orders/application/ports/inbound/order-operations-read.port';
import {
  FINANCE_OVERSIGHT_PORT,
  IFinanceOversightPort,
  PaymentMethod,
  PaymentStatus,
} from '../../../payment/application/ports/inbound/finance-oversight.port';
import { AdminErrors } from '../../domain/errors';

export const DEFAULT_ORDER_OPERATIONS_PAGE = 1;
export const DEFAULT_ORDER_OPERATIONS_PAGE_SIZE = 20;
export const MAX_ORDER_OPERATIONS_PAGE_SIZE = 100;

export interface ListOrderOperationsInput extends OrderOperationsFilter {
  page?: number;
  size?: number;
}

/**
 * `GET /admin/operations/orders` (module-16 Work 35): orders newest first, through Module 06's
 * `ORDER_OPERATIONS_READ_PORT`. Paging clamped to 1..100 (default 20), as every Module 16 list. Module
 * 06 data only — no payment or delivery lookup per row. Read-only; not audited.
 */
@Injectable()
export class ListOrderOperationsQuery {
  constructor(@Inject(ORDER_OPERATIONS_READ_PORT) private readonly orders: IOrderOperationsReadPort) {}

  execute(input: ListOrderOperationsInput): Promise<OrderOperationsPage> {
    const page = input.page && Number.isFinite(input.page) && input.page > 0 ? Math.floor(input.page) : DEFAULT_ORDER_OPERATIONS_PAGE;
    const size =
      input.size && Number.isFinite(input.size) && input.size > 0
        ? Math.min(Math.floor(input.size), MAX_ORDER_OPERATIONS_PAGE_SIZE)
        : DEFAULT_ORDER_OPERATIONS_PAGE_SIZE;
    const filter: OrderOperationsFilter = {
      status: input.status,
      isCod: input.isCod,
      orderNumber: input.orderNumber,
      createdFrom: input.createdFrom,
      createdTo: input.createdTo,
      hasDeliveryJobReference: input.hasDeliveryJobReference,
      hasUnreferencedFulfillment: input.hasUnreferencedFulfillment,
    };
    return this.orders.listOrders(filter, page, size);
  }
}

/**
 * The order's payment as Module 07 records it now — its own status, method and last change, nothing
 * else (no amount re-statement, provider reference, customer or failure text). Read after the order,
 * through a separate call: the two are not one snapshot.
 */
export interface OrderPaymentStatusView {
  paymentId: string;
  status: PaymentStatus;
  method: PaymentMethod;
  updatedAt: Date;
}

export interface OrderOperationsDetailView {
  order: OrderOperationsDetail;
  /** `null` when the order has no payment linked (`orders.paymentId` is empty), or Module 07 has none by that id. */
  payment: OrderPaymentStatusView | null;
}

/**
 * `GET /admin/operations/orders/:orderId` (module-16 Work 35): one order through Module 06, and — when
 * the order links one — its payment's status through Module 07's existing `FINANCE_OVERSIGHT_PORT`.
 * Unknown order → 404. No delivery-job status here: a fulfillment's `deliveryJobId` is shown by
 * reference only, and the job's own Module 08 status is read at `GET /admin/operations/deliveries/:id`
 * (Work 36's `DELIVERY_OPERATIONS_READ_PORT`). Read-only; not audited.
 */
@Injectable()
export class GetOrderOperationsQuery {
  constructor(
    @Inject(ORDER_OPERATIONS_READ_PORT) private readonly orders: IOrderOperationsReadPort,
    @Inject(FINANCE_OVERSIGHT_PORT) private readonly finance: IFinanceOversightPort,
  ) {}

  async execute(orderId: string): Promise<OrderOperationsDetailView> {
    const order = await this.orders.getOrder(orderId);
    if (!order) throw AdminErrors.orderNotFound();
    const detail = order.paymentId ? await this.finance.getPayment(order.paymentId) : null;
    const payment = detail
      ? { paymentId: detail.payment.paymentId, status: detail.payment.status, method: detail.payment.method, updatedAt: detail.payment.updatedAt }
      : null;
    return { order, payment };
  }
}
