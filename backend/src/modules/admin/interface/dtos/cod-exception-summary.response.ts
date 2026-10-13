import { CodExceptionSummary } from '../../../delivery/application/ports/inbound/cod-exception-summary-read.port';

/** Aggregate counts and timestamps only — no record identifier, amount or free text. */
export interface CodExceptionSummaryResponse {
  generatedAt: string;
  collections: {
    total: number;
    byStatus: Record<string, number>;
    outstandingCount: number;
    oldestOutstandingCollectedAt: string | null;
    oldestOutstandingAgeSeconds: number | null;
  };
  exceptions: {
    discrepancyCount: number;
    reconciliationDiscrepancyCount: number;
    collectionsWithCorrectionsCount: number;
    collectionsWithOpenDisputesCount: number;
    openDisputeCount: number;
  };
}

// Explicit allow-list, never a spread of the port object.
export function toCodExceptionSummaryResponse(s: CodExceptionSummary): CodExceptionSummaryResponse {
  const c = s.collections;
  const e = s.exceptions;
  return {
    generatedAt: s.generatedAt.toISOString(),
    collections: {
      total: c.total,
      byStatus: Object.fromEntries(Object.entries(c.byStatus).map(([status, n]) => [status, n])),
      outstandingCount: c.outstandingCount,
      oldestOutstandingCollectedAt: c.oldestOutstandingCollectedAt ? c.oldestOutstandingCollectedAt.toISOString() : null,
      oldestOutstandingAgeSeconds: c.oldestOutstandingAgeSeconds,
    },
    exceptions: {
      discrepancyCount: e.discrepancyCount,
      reconciliationDiscrepancyCount: e.reconciliationDiscrepancyCount,
      collectionsWithCorrectionsCount: e.collectionsWithCorrectionsCount,
      collectionsWithOpenDisputesCount: e.collectionsWithOpenDisputesCount,
      openDisputeCount: e.openDisputeCount,
    },
  };
}
