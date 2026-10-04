import {
  CodDisputeDetailView,
  CodDisputePage,
  CodDisputeProps,
  CodDisputeRecord,
  CodDisputeResolutionResult,
  CodReconciliationView,
} from '../../../delivery/application/ports/inbound/cod-dispute-admin.port';

/** One dispute, as Module 08's own `CodDisputeResponse` reports it. */
export interface CodDisputeResponse {
  id: string;
  collectionId: string;
  reason: string;
  status: string;
  openedByUserId: string;
  openedAt: string;
  resolvedByUserId: string | null;
  resolvedAt: string | null;
  resolutionNote: string | null;
}

/**
 * The collection a queue row questions — enough to triage. The original figures only; the
 * variance a reader wants to see at a glance is on the detail, where its inputs are beside it.
 */
export interface CodDisputeCollectionSummaryResponse {
  id: string;
  jobId: string;
  orderId: string;
  driverId: string;
  expectedAmount: number;
  collectedAmount: number;
  currency: string;
  status: string;
}

export interface CodDisputeListItemResponse {
  dispute: CodDisputeResponse;
  collection: CodDisputeCollectionSummaryResponse;
}

export interface CodDisputeListResponse {
  items: CodDisputeListItemResponse[];
  total: number;
  page: number;
  size: number;
}

export interface CodRemittanceResponse {
  id: string;
  remittedAmount: number;
  currency: string;
  reference: string;
  note: string | null;
  confirmedByUserId: string;
  remittedAt: string;
}

export interface CodReconciliationResponse {
  id: string;
  outcome: string;
  reference: string | null;
  note: string | null;
  reconciledByUserId: string;
  reconciledAt: string;
}

/** A correction as filed. The replay key is an implementation detail and is not carried. */
export interface CodCorrectionResponse {
  id: string;
  remittanceId: string | null;
  reconciliationId: string | null;
  type: string;
  originalAmount: number | null;
  correctedAmount: number | null;
  originalReference: string | null;
  correctedReference: string | null;
  reason: string;
  createdByUserId: string;
  createdAt: string;
}

/**
 * The collection in full, as Module 08's own finance detail reports it: original figures, what
 * happened to them, every record filed beside them, and the derived variances. An explicit
 * allow-list; nothing from Module 01 (no phone, no name, no document) is anywhere in it.
 */
export interface CodDisputeCollectionDetailResponse extends CodDisputeCollectionSummaryResponse {
  fulfillmentId: string;
  method: string;
  providerReference: string | null;
  collectedAt: string;
  recordedAt: string;
  remittedAt: string | null;
  reconciledAt: string | null;
  collectionVariance: number;
  remittanceVariance: number | null;
  hasDiscrepancy: boolean;
  isOutstanding: boolean;
  remittance: CodRemittanceResponse | null;
  reconciliation: CodReconciliationResponse | null;
  corrections: CodCorrectionResponse[];
  disputes: CodDisputeResponse[];
}

export interface CodDisputeDetailResponse {
  dispute: CodDisputeResponse;
  collection: CodDisputeCollectionDetailResponse;
}

export interface CodDisputeResolutionResponse {
  dispute: CodDisputeResponse;
  collectionId: string;
  previousStatus: string;
  changed: boolean;
}

export function toCodDisputeResponse(d: CodDisputeProps): CodDisputeResponse {
  return {
    id: d.id,
    collectionId: d.collectionId,
    reason: d.reason,
    status: d.status,
    openedByUserId: d.openedByUserId,
    openedAt: d.openedAt.toISOString(),
    resolvedByUserId: d.resolvedByUserId,
    resolvedAt: d.resolvedAt?.toISOString() ?? null,
    resolutionNote: d.resolutionNote,
  };
}

function toCollectionSummary(c: CodDisputeRecord['collection']): CodDisputeCollectionSummaryResponse {
  return {
    id: c.id,
    jobId: c.jobId,
    orderId: c.orderId,
    driverId: c.driverId,
    expectedAmount: c.expectedAmount,
    collectedAmount: c.collectedAmount,
    currency: c.currency,
    status: c.status,
  };
}

export function toCodDisputeListResponse(page: CodDisputePage): CodDisputeListResponse {
  return {
    items: page.items.map((row) => ({
      dispute: toCodDisputeResponse(row.dispute),
      collection: toCollectionSummary(row.collection),
    })),
    total: page.total,
    page: page.page,
    size: page.size,
  };
}

function toCollectionDetail(view: CodReconciliationView): CodDisputeCollectionDetailResponse {
  const c = view.collection;
  return {
    ...toCollectionSummary(c),
    fulfillmentId: c.fulfillmentId,
    method: c.method,
    providerReference: c.providerReference,
    collectedAt: c.collectedAt.toISOString(),
    recordedAt: c.recordedAt.toISOString(),
    remittedAt: c.remittedAt?.toISOString() ?? null,
    reconciledAt: c.reconciledAt?.toISOString() ?? null,
    collectionVariance: view.collectionVariance,
    remittanceVariance: view.remittanceVariance,
    hasDiscrepancy: view.hasDiscrepancy,
    isOutstanding: view.isOutstanding,
    remittance: view.remittance
      ? {
          id: view.remittance.id,
          remittedAmount: view.remittance.remittedAmount,
          currency: view.remittance.currency,
          reference: view.remittance.reference,
          note: view.remittance.note,
          confirmedByUserId: view.remittance.confirmedByUserId,
          remittedAt: view.remittance.remittedAt.toISOString(),
        }
      : null,
    reconciliation: view.reconciliation
      ? {
          id: view.reconciliation.id,
          outcome: view.reconciliation.outcome,
          reference: view.reconciliation.reference,
          note: view.reconciliation.note,
          reconciledByUserId: view.reconciliation.reconciledByUserId,
          reconciledAt: view.reconciliation.reconciledAt.toISOString(),
        }
      : null,
    corrections: view.corrections.map((x) => ({
      id: x.id,
      remittanceId: x.remittanceId,
      reconciliationId: x.reconciliationId,
      type: x.type,
      originalAmount: x.originalAmount,
      correctedAmount: x.correctedAmount,
      originalReference: x.originalReference,
      correctedReference: x.correctedReference,
      reason: x.reason,
      createdByUserId: x.createdByUserId,
      createdAt: x.createdAt.toISOString(),
    })),
    disputes: view.disputes.map(toCodDisputeResponse),
  };
}

export function toCodDisputeDetailResponse(view: CodDisputeDetailView): CodDisputeDetailResponse {
  return { dispute: toCodDisputeResponse(view.dispute), collection: toCollectionDetail(view.collection) };
}

export function toCodDisputeResolutionResponse(
  result: CodDisputeResolutionResult,
): CodDisputeResolutionResponse {
  return {
    dispute: toCodDisputeResponse(result.dispute),
    collectionId: result.collectionId,
    previousStatus: result.previousStatus,
    changed: result.changed,
  };
}
