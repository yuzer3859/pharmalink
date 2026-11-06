export const ORDER_OWNERSHIP_READ_PORT = Symbol('ORDER_OWNERSHIP_READ_PORT');

/** The facts a dispute needs about the customer's own order (Work 86). Nothing else of the order. */
export interface CustomerOrderReference {
  orderId: string;
  orderNumber: string;
  customerUserId: string;
}

/**
 * Module 06's answer to "is this order this customer's?" for Admin's dispute intake (Work 86,
 * module-16 §7). A separate, minimal port: `ORDER_OPERATIONS_READ_PORT` deliberately carries no
 * customer, and an operations view is the wrong place to add one.
 */
export interface IOrderOwnershipReadPort {
  /** `null` when the order does not exist. */
  findOrder(orderId: string): Promise<CustomerOrderReference | null>;
}
