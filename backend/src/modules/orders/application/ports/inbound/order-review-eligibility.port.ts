import { FulfillmentStatus, OrderStatus } from '../../../domain/enums';

export const ORDER_REVIEW_ELIGIBILITY_PORT = Symbol('ORDER_REVIEW_ELIGIBILITY_PORT');

export { FulfillmentStatus, OrderStatus } from '../../../domain/enums';

/** What Module 15 needs to decide whether an order can be reviewed, and of which pharmacies (Work 91). */
export interface ReviewableOrderView {
  orderId: string;
  customerUserId: string;
  status: OrderStatus;
  completedAt: Date | null;
  /** One entry per fulfilment: the pharmacy that fulfilled it and how far it got. */
  fulfillments: Array<{ pharmacyId: string; status: FulfillmentStatus }>;
}

/**
 * Module 06's inbound read for Module 15's verified-review gate (BRULE-45): an order's owner,
 * status and the pharmacies that fulfilled it. Read-only; no other order field crosses it.
 */
export interface IOrderReviewEligibilityPort {
  findOrder(orderId: string): Promise<ReviewableOrderView | null>;
}
