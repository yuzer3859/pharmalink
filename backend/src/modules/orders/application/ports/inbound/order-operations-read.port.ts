import { FulfillmentStatus, OrderStatus } from '../../../domain/enums';

export const ORDER_OPERATIONS_READ_PORT = Symbol('ORDER_OPERATIONS_READ_PORT');

/** Re-exported so a consumer depends on this one file and not on Module 06's domain layer. */
export { FulfillmentStatus, OrderStatus } from '../../../domain/enums';

/** What an administrator may narrow orders by — each a real `orders` column, matched exactly. */
export interface OrderOperationsFilter {
  status?: OrderStatus;
  isCod?: boolean;
  /** Exact match on the human-facing reference; not a search. */
  orderNumber?: string;
  /** Inclusive lower bound on `createdAt`. */
  createdFrom?: Date;
  /** Exclusive upper bound on `createdAt`. */
  createdTo?: Date;
}

/**
 * One order as operations sees it — Module 06's own columns, unreinterpreted. No customer, beneficiary,
 * address, delivery slot, cancellation note or idempotency key. `lineCount` is the number of order
 * lines; `fulfillmentCount` the number of fulfillments (one per pharmacy branch).
 */
export interface OrderOperationsSummary {
  orderId: string;
  orderNumber: string;
  status: OrderStatus;
  isCod: boolean;
  grandTotal: number;
  currency: string;
  lineCount: number;
  fulfillmentCount: number;
  placedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** One fulfillment — Module 06's own row. `deliveryJobId` is Module 08's job, by reference only. */
export interface OrderOperationsFulfillment {
  fulfillmentId: string;
  pharmacyId: string;
  branchId: string;
  status: FulfillmentStatus;
  deliveryJobId: string | null;
  acceptedAt: Date | null;
  readyAt: Date | null;
  createdAt: Date;
}

/**
 * One order in detail: the summary, its money breakdown (integer minor units, the order's currency),
 * its lifecycle timestamps, its fulfillments, and the id of its payment (Module 07's, by reference).
 */
export interface OrderOperationsDetail extends OrderOperationsSummary {
  subtotal: number;
  deliveryFee: number;
  platformFee: number;
  discountTotal: number;
  completedAt: Date | null;
  cancelledAt: Date | null;
  paymentId: string | null;
  fulfillments: OrderOperationsFulfillment[];
}

export interface OrderOperationsPage {
  items: OrderOperationsSummary[];
  total: number;
  page: number;
  size: number;
}

/**
 * Module 06's exported, read-only contract for **administrative order investigation** (module-16
 * Work 35), consumed in-process by Module 16. Reads only — it can change no order, line or
 * fulfillment. Newest first (`createdAt`, then `id`), paged in the database.
 */
export interface IOrderOperationsReadPort {
  listOrders(filter: OrderOperationsFilter, page: number, size: number): Promise<OrderOperationsPage>;
  /** `null` when there is no such order. */
  getOrder(orderId: string): Promise<OrderOperationsDetail | null>;
}
