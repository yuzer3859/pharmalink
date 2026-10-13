import {
  DeliveryOperationsDetail,
  DeliveryOperationsPage,
  DeliveryOperationsSummary,
} from '../../../delivery/application/ports/inbound/delivery-operations-read.port';

/** One delivery job in a list — Module 08's columns, no address, position or driver person. */
export interface DeliveryOperationsSummaryResponse {
  deliveryJobId: string;
  orderId: string;
  fulfillmentId: string;
  pharmacyId: string;
  branchId: string;
  status: string;
  driverProfileId: string | null;
  isCod: boolean;
  isColdChain: boolean;
  etaAt: string | null;
  pickedUpAt: string | null;
  deliveredAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DeliveryOperationsListResponse {
  items: DeliveryOperationsSummaryResponse[];
  total: number;
  page: number;
  size: number;
}

export interface DeliveryOperationsDetailResponse extends DeliveryOperationsSummaryResponse {
  timeline: {
    assignedAt: string | null;
    arrivedPickupAt: string | null;
    pickedUpAt: string | null;
    enRouteAt: string | null;
    arrivedDropoffAt: string | null;
    deliveredAt: string | null;
    completedAt: string | null;
    failedAt: string | null;
    cancelledAt: string | null;
  };
  /** Module 08's COD collection state for this job (money in integer minor units); `null` when none. */
  cod: {
    collectionId: string;
    status: string;
    method: string;
    expectedAmount: number;
    collectedAmount: number;
    currency: string;
    collectedAt: string;
    remittedAt: string | null;
    reconciledAt: string | null;
  } | null;
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

// Explicit allow-lists, never spreads of port objects.
export function toDeliveryOperationsSummaryResponse(j: DeliveryOperationsSummary): DeliveryOperationsSummaryResponse {
  return {
    deliveryJobId: j.deliveryJobId,
    orderId: j.orderId,
    fulfillmentId: j.fulfillmentId,
    pharmacyId: j.pharmacyId,
    branchId: j.branchId,
    status: j.status,
    driverProfileId: j.driverProfileId,
    isCod: j.isCod,
    isColdChain: j.isColdChain,
    etaAt: iso(j.etaAt),
    pickedUpAt: iso(j.pickedUpAt),
    deliveredAt: iso(j.deliveredAt),
    createdAt: j.createdAt.toISOString(),
    updatedAt: j.updatedAt.toISOString(),
  };
}

export function toDeliveryOperationsListResponse(p: DeliveryOperationsPage): DeliveryOperationsListResponse {
  return { items: p.items.map(toDeliveryOperationsSummaryResponse), total: p.total, page: p.page, size: p.size };
}

export function toDeliveryOperationsDetailResponse(j: DeliveryOperationsDetail): DeliveryOperationsDetailResponse {
  const t = j.timeline;
  return {
    ...toDeliveryOperationsSummaryResponse(j),
    timeline: {
      assignedAt: iso(t.assignedAt),
      arrivedPickupAt: iso(t.arrivedPickupAt),
      pickedUpAt: iso(t.pickedUpAt),
      enRouteAt: iso(t.enRouteAt),
      arrivedDropoffAt: iso(t.arrivedDropoffAt),
      deliveredAt: iso(t.deliveredAt),
      completedAt: iso(t.completedAt),
      failedAt: iso(t.failedAt),
      cancelledAt: iso(t.cancelledAt),
    },
    cod: j.cod
      ? {
          collectionId: j.cod.collectionId,
          status: j.cod.status,
          method: j.cod.method,
          expectedAmount: j.cod.expectedAmount,
          collectedAmount: j.cod.collectedAmount,
          currency: j.cod.currency,
          collectedAt: j.cod.collectedAt.toISOString(),
          remittedAt: iso(j.cod.remittedAt),
          reconciledAt: iso(j.cod.reconciledAt),
        }
      : null,
  };
}
