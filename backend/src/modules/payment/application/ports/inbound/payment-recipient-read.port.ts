export const PAYMENT_RECIPIENT_READ_PORT = Symbol('PAYMENT_RECIPIENT_READ_PORT');

/**
 * Who a payment belongs to, and the two references a customer notification about it needs.
 *
 * - `customerUserId` — the recipient.
 * - `currency` — `payment.refunded` carries an `amount` in minor units but no currency; the
 *   refund is in the payment's currency, and a notification cannot state the amount without it.
 * - `orderId` — the customer's handle on what was paid for; their payments and refunds are
 *   reached through the order.
 *
 * Nothing else: no amount, status, method, provider, provider reference or token, failure detail
 * or ledger figure.
 */
export interface PaymentRecipientView {
  customerUserId: string;
  orderId: string;
  currency: string;
}

/**
 * Module 07's exported contract for **who a payment belongs to**, consumed in-process by Module
 * 13 to address refund notifications (module-13 Work 03): `payment.refunded` carries the
 * `paymentId` and the refunded `amount`, but not the customer. Read-only; Module 07 stays the only
 * module that reads `payments`.
 */
export interface IPaymentRecipientReadPort {
  /** The payment's recipient view, or `null` when no such payment exists. */
  recipientOf(paymentId: string): Promise<PaymentRecipientView | null>;
}
