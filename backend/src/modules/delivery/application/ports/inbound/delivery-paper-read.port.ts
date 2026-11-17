import type { DeliveryPaperState } from '../../../domain/repositories/delivery-paper.repository';

export const DELIVERY_PAPER_READ_PORT = Symbol('DELIVERY_PAPER_READ_PORT');

export type DeliveryPaperView = DeliveryPaperState;

/**
 * Work 136: Module 08's exported read for Module 06 — where an order's original paper prescription
 * is. The pharmacist may check the paper only once the driver has collected it from the customer
 * and arrived at the pharmacy with it.
 */
export interface IDeliveryPaperReadPort {
  findByFulfillmentId(fulfillmentId: string): Promise<DeliveryPaperView | null>;
}
