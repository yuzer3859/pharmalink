export const ORDER_PAPER_REPOSITORY = Symbol('ORDERS_ORDER_PAPER_REPOSITORY');

export interface OrderPaperState {
  orderId: string;
  paperRxRequired: boolean;
  paperRxVerifiedAt: Date | null;
  paperRxVerifiedById: string | null;
}

/** Work 136: the pharmacist's check of the original paper prescription, on the order. */
export interface IOrderPaperRepository {
  findByOrderId(orderId: string, tx?: unknown): Promise<OrderPaperState | null>;
  /** Compare-and-set: records the check once. `false` when already recorded (or not required). */
  markVerified(orderId: string, userId: string, at: Date, tx?: unknown): Promise<boolean>;
}
