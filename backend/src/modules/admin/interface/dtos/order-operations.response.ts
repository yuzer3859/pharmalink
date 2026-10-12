import { OrderOperationsPage, OrderOperationsSummary } from '../../../orders/application/ports/inbound/order-operations-read.port';
import { OrderOperationsDetailView } from '../../application/queries/order-operations.queries';

/** One order in a list — Module 06's columns, no customer data. Money in integer minor units. */
export interface OrderOperationsSummaryResponse {
  orderId: string;
  orderNumber: string;
  status: string;
  isCod: boolean;
  grandTotal: number;
  currency: string;
  lineCount: number;
  fulfillmentCount: number;
  placedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface OrderOperationsListResponse {
  items: OrderOperationsSummaryResponse[];
  total: number;
  page: number;
  size: number;
}

export interface OrderOperationsDetailResponse extends OrderOperationsSummaryResponse {
  subtotal: number;
  deliveryFee: number;
  platformFee: number;
  discountTotal: number;
  completedAt: string | null;
  cancelledAt: string | null;
  fulfillments: Array<{
    fulfillmentId: string;
    pharmacyId: string;
    branchId: string;
    status: string;
    deliveryJobId: string | null;
    acceptedAt: string | null;
    readyAt: string | null;
    createdAt: string;
  }>;
  /** Module 07's payment status, read separately from the order (not one snapshot); `null` when none. */
  payment: { paymentId: string; status: string; method: string; updatedAt: string } | null;
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

// Explicit allow-lists, never spreads.
export function toOrderOperationsSummaryResponse(o: OrderOperationsSummary): OrderOperationsSummaryResponse {
  return {
    orderId: o.orderId,
    orderNumber: o.orderNumber,
    status: o.status,
    isCod: o.isCod,
    grandTotal: o.grandTotal,
    currency: o.currency,
    lineCount: o.lineCount,
    fulfillmentCount: o.fulfillmentCount,
    placedAt: iso(o.placedAt),
    createdAt: o.createdAt.toISOString(),
    updatedAt: o.updatedAt.toISOString(),
  };
}

export function toOrderOperationsListResponse(p: OrderOperationsPage): OrderOperationsListResponse {
  return { items: p.items.map(toOrderOperationsSummaryResponse), total: p.total, page: p.page, size: p.size };
}

export function toOrderOperationsDetailResponse(v: OrderOperationsDetailView): OrderOperationsDetailResponse {
  const o = v.order;
  return {
    ...toOrderOperationsSummaryResponse(o),
    subtotal: o.subtotal,
    deliveryFee: o.deliveryFee,
    platformFee: o.platformFee,
    discountTotal: o.discountTotal,
    completedAt: iso(o.completedAt),
    cancelledAt: iso(o.cancelledAt),
    fulfillments: o.fulfillments.map((f) => ({
      fulfillmentId: f.fulfillmentId,
      pharmacyId: f.pharmacyId,
      branchId: f.branchId,
      status: f.status,
      deliveryJobId: f.deliveryJobId,
      acceptedAt: iso(f.acceptedAt),
      readyAt: iso(f.readyAt),
      createdAt: f.createdAt.toISOString(),
    })),
    payment: v.payment
      ? { paymentId: v.payment.paymentId, status: v.payment.status, method: v.payment.method, updatedAt: v.payment.updatedAt.toISOString() }
      : null,
  };
}
