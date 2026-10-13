import {
  CodOperationsDetail,
  CodOperationsPage,
  CodOperationsSummary,
} from '../../../delivery/application/ports/inbound/cod-operations-read.port';

/** One COD collection — Module 08's ids, statuses, amounts (integer minor units) and times. */
export interface CodOperationsSummaryResponse {
  collectionId: string;
  jobId: string;
  orderId: string;
  fulfillmentId: string;
  driverProfileId: string;
  status: string;
  method: string;
  currency: string;
  expectedAmount: number;
  collectedAmount: number;
  remittedAmount: number | null;
  collectionVariance: number;
  remittanceVariance: number | null;
  hasDiscrepancy: boolean;
  isOutstanding: boolean;
  reconciliationOutcome: string | null;
  collectedAt: string;
  recordedAt: string;
  remittedAt: string | null;
  reconciledAt: string | null;
  correctionCount: number;
  disputeCount: number;
  openDisputeCount: number;
}

export interface CodOperationsListResponse {
  items: CodOperationsSummaryResponse[];
  total: number;
  page: number;
  size: number;
}

export interface CodOperationsDetailResponse extends CodOperationsSummaryResponse {
  remittance: { remittanceId: string; remittedAmount: number; currency: string; remittedAt: string; recordedAt: string } | null;
  reconciliation: { reconciliationId: string; outcome: string; reconciledAt: string } | null;
  corrections: Array<{
    correctionId: string;
    type: string;
    remittanceId: string | null;
    reconciliationId: string | null;
    originalAmount: number | null;
    correctedAmount: number | null;
    createdAt: string;
  }>;
  disputes: Array<{ disputeId: string; status: string; openedAt: string; resolvedAt: string | null }>;
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

// Explicit allow-lists, never spreads of port objects.
export function toCodOperationsSummaryResponse(c: CodOperationsSummary): CodOperationsSummaryResponse {
  return {
    collectionId: c.collectionId,
    jobId: c.jobId,
    orderId: c.orderId,
    fulfillmentId: c.fulfillmentId,
    driverProfileId: c.driverProfileId,
    status: c.status,
    method: c.method,
    currency: c.currency,
    expectedAmount: c.expectedAmount,
    collectedAmount: c.collectedAmount,
    remittedAmount: c.remittedAmount,
    collectionVariance: c.collectionVariance,
    remittanceVariance: c.remittanceVariance,
    hasDiscrepancy: c.hasDiscrepancy,
    isOutstanding: c.isOutstanding,
    reconciliationOutcome: c.reconciliationOutcome,
    collectedAt: c.collectedAt.toISOString(),
    recordedAt: c.recordedAt.toISOString(),
    remittedAt: iso(c.remittedAt),
    reconciledAt: iso(c.reconciledAt),
    correctionCount: c.correctionCount,
    disputeCount: c.disputeCount,
    openDisputeCount: c.openDisputeCount,
  };
}

export function toCodOperationsListResponse(p: CodOperationsPage): CodOperationsListResponse {
  return { items: p.items.map(toCodOperationsSummaryResponse), total: p.total, page: p.page, size: p.size };
}

export function toCodOperationsDetailResponse(c: CodOperationsDetail): CodOperationsDetailResponse {
  return {
    ...toCodOperationsSummaryResponse(c),
    remittance: c.remittance
      ? {
          remittanceId: c.remittance.remittanceId,
          remittedAmount: c.remittance.remittedAmount,
          currency: c.remittance.currency,
          remittedAt: c.remittance.remittedAt.toISOString(),
          recordedAt: c.remittance.recordedAt.toISOString(),
        }
      : null,
    reconciliation: c.reconciliation
      ? { reconciliationId: c.reconciliation.reconciliationId, outcome: c.reconciliation.outcome, reconciledAt: c.reconciliation.reconciledAt.toISOString() }
      : null,
    corrections: c.corrections.map((x) => ({
      correctionId: x.correctionId,
      type: x.type,
      remittanceId: x.remittanceId,
      reconciliationId: x.reconciliationId,
      originalAmount: x.originalAmount,
      correctedAmount: x.correctedAmount,
      createdAt: x.createdAt.toISOString(),
    })),
    disputes: c.disputes.map((d) => ({ disputeId: d.disputeId, status: d.status, openedAt: d.openedAt.toISOString(), resolvedAt: iso(d.resolvedAt) })),
  };
}
