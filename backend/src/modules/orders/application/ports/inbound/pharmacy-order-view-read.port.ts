import { FulfillmentStatus, OrderLineStatus, OrderStatus } from '../../../domain/enums';

/**
 * Work 107: what a pharmacy needs to prepare its part of an order (module-06 §9.4), read for the
 * pharmacy portal. A fulfilment with its order's header and the lines it carries.
 *
 * Work 129 (owner decision 2026-11-16): the pharmacist reviews the order's prescription on the
 * order, so the view names who ordered (the customer's profile name) and carries the attached
 * prescription's summary; its file opens through Module 05's audited preview link. Still **no
 * customer contact data**: no phone, e-mail or address. The driver delivers.
 */
export interface PharmacyOrderPrescriptionView {
  id: string;
  /** Module 05's status of the prescription. */
  status: string;
  fileType: string | null;
  doctorName: string | null;
  hospitalName: string | null;
  uploadedAt: Date;
}

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
    /** Work 129: `PENDING` while the pharmacist reviews the attached prescription. */
    rxReviewStatus: string | null;
  };
  /** Work 129: the customer's name from their profile; `null` when they have not given one. */
  customerName: string | null;
  /** Work 129: the prescription attached to the order; `null` when it has none. */
  prescription: PharmacyOrderPrescriptionView | null;
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
