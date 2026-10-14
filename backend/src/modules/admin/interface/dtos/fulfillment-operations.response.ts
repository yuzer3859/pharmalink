import {
  FulfillmentOperationsPage,
  FulfillmentOperationsView,
} from '../../../orders/application/ports/inbound/fulfillment-operations-read.port';

/**
 * One fulfillment — Module 06's columns, the same fields Work 35's order detail shows per fulfillment,
 * plus its order id and the reference flag. `deliveryJobId` is a recorded reference for navigation to
 * `GET /admin/operations/deliveries/:id`; no delivery status is carried or derived here.
 */
export interface FulfillmentOperationsResponse {
  fulfillmentId: string;
  orderId: string;
  pharmacyId: string;
  branchId: string;
  status: string;
  deliveryJobId: string | null;
  hasDeliveryJobReference: boolean;
  acceptedAt: string | null;
  readyAt: string | null;
  createdAt: string;
}

export interface FulfillmentOperationsListResponse {
  items: FulfillmentOperationsResponse[];
  total: number;
  page: number;
  size: number;
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

// Explicit allow-list, never a spread of the port object.
export function toFulfillmentOperationsResponse(f: FulfillmentOperationsView): FulfillmentOperationsResponse {
  return {
    fulfillmentId: f.fulfillmentId,
    orderId: f.orderId,
    pharmacyId: f.pharmacyId,
    branchId: f.branchId,
    status: f.status,
    deliveryJobId: f.deliveryJobId,
    hasDeliveryJobReference: f.hasDeliveryJobReference,
    acceptedAt: iso(f.acceptedAt),
    readyAt: iso(f.readyAt),
    createdAt: f.createdAt.toISOString(),
  };
}

export function toFulfillmentOperationsListResponse(p: FulfillmentOperationsPage): FulfillmentOperationsListResponse {
  return { items: p.items.map(toFulfillmentOperationsResponse), total: p.total, page: p.page, size: p.size };
}
