export const ORDER_RECIPIENT_READ_PORT = Symbol('ORDER_RECIPIENT_READ_PORT');

/**
 * Module 06's exported contract for **who an order belongs to**, consumed in-process by Module 13
 * to address order lifecycle notifications (module-13 Work 02). `order.accepted`, `order.ready`
 * and `order.cancelled` carry the `orderId` but not the customer, and Module 06 stays the only
 * module that reads `orders`.
 *
 * One field, one order, read-only: no address, beneficiary, line, total or payment detail crosses
 * this seam.
 */
export interface IOrderRecipientReadPort {
  /** The order's `customerUserId`, or `null` when no such order exists. */
  customerUserIdOf(orderId: string): Promise<string | null>;
}
