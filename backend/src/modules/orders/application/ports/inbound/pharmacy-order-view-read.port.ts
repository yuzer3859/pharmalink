import { FulfillmentStatus, OrderLineStatus, OrderStatus } from '../../../domain/enums';

/**
 * Work 107: what a pharmacy needs to prepare its part of an order (module-06 §9.4), read for the
 * pharmacy portal. A fulfilment with its order's header and the lines it carries.
 *
 * Deliberately **no customer contact data**: no name, phone or address. The pharmacy prepares
 * and hands over; the driver delivers. What a pharmacist needs for the prescription comes from
 * the verification queue (Module 05), not from here.
 */
export interface PharmacyOrderLineView {
  id: string;
  catalogProductId: string;
  /** From the checkout-time product snapshot; `null` when the snapshot has no name. */
  productName: string | null;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
  requiresRx: boolean;
  lineStatus: OrderLineStatus;
}

export interface PharmacyOrderView {
  id: string;
  orderId: string;
  pharmacyId: string;
  branchId: string;
  status: FulfillmentStatus;
  deliveryJobId: string | null;
  acceptedAt: Date | null;
  readyAt: Date | null;
  createdAt: Date;
  order: {
    orderNumber: string;
    status: OrderStatus;
    isCod: boolean;
    grandTotal: number;
    currency: string;
    placedAt: Date | null;
    deliverySlot: string | null;
  };
  /** The order's lines this fulfilment carries. */
  lines: PharmacyOrderLineView[];
  /** At least one line needs a prescription. */
  requiresRx: boolean;
}

export interface PharmacyOrderViewCriteria {
  pharmacyIds: string[];
  status?: FulfillmentStatus;
  page: number;
  size: number;
}

export interface IPharmacyOrderViewReadPort {
  /** `GET /pharmacy/orders`: newest first, the same visibility rule as the fulfilment list. */
  list(criteria: PharmacyOrderViewCriteria): Promise<{ items: PharmacyOrderView[]; total: number }>;
  /** `GET /pharmacy/orders/:fulfillmentId`: `null` when absent, not visible, or not one of `pharmacyIds`. */
  findById(fulfillmentId: string, pharmacyIds: string[]): Promise<PharmacyOrderView | null>;
}

export const PHARMACY_ORDER_VIEW_READ_PORT = Symbol('PHARMACY_ORDER_VIEW_READ_PORT');
