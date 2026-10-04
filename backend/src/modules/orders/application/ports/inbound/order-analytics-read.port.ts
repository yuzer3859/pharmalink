import { FulfillmentStatus, OrderStatus } from '../../../domain/enums';

export const ORDER_ANALYTICS_READ_PORT = Symbol('ORDER_ANALYTICS_READ_PORT');

/** Re-exported so a consumer depends on this one file and not on Module 06's domain layer. */
export { FulfillmentStatus, OrderStatus } from '../../../domain/enums';

export interface OrderStatusCount {
  status: OrderStatus;
  count: number;
}

export interface FulfillmentStatusCount {
  status: FulfillmentStatus;
  count: number;
}

/**
 * Orders and fulfillments, counted by their **current** persisted status. Every row counts
 * (`orders` and `fulfillments` have no soft delete; `CANCELLED` is a status). Both breakdowns
 * carry every enum value in declaration order, zero-filled, so each `total` is Σ its `byStatus`.
 *
 * These are operational counts and nothing else: an order's `grandTotal` is not summed here,
 * because "orders in a status" is not money — what was actually paid is a Module 07 payment and
 * what a pharmacy is owed is a Module 07 statement, each reported on its own surface.
 */
export interface OrderAnalyticsView {
  orders: {
    total: number;
    byStatus: OrderStatusCount[];
  };
  fulfillments: {
    total: number;
    byStatus: FulfillmentStatusCount[];
  };
}

/**
 * Module 06's exported contract for **read-only order analytics**, consumed in-process by
 * Module 16 (module-16 Work 08). Counts only — no order, no line, no customer, no address.
 */
export interface IOrderAnalyticsReadPort {
  summarizeOrders(): Promise<OrderAnalyticsView>;
}
