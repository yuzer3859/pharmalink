import { CodCollectionStatus } from '../../../domain/enums';

export const COD_EXCEPTION_SUMMARY_READ_PORT = Symbol('COD_EXCEPTION_SUMMARY_READ_PORT');

/** Re-exported so a consumer depends on this one file and not on Module 08's domain layer. */
export { CodCollectionStatus } from '../../../domain/enums';

/**
 * Counts and timestamps over every COD collection (none is ever deleted), from one SQL statement —
 * one snapshot. No amounts: expected, collected and remitted are different stages, and no total of
 * them has a single meaning.
 *
 * Every flag is `toCodReconciliationView`'s, in the SQL form both aggregates share
 * (`cod-collection.sql.ts`):
 *
 * - `outstandingCount` — `isOutstanding`: status ≠ RECONCILED.
 * - `oldestOutstandingCollectedAt` / `oldestOutstandingAgeSeconds` — the earliest `collectedAt`
 *   among those, and whole seconds from it to `generatedAt` (floored, never negative); both `null`
 *   when nothing is outstanding.
 * - `discrepancyCount` — `hasDiscrepancy`: collected ≠ expected, or remitted ≠ collected once a
 *   remittance exists.
 * - `reconciliationDiscrepancyCount` — reconciliation rows whose recorded `outcome` is DISCREPANCY
 *   (at most one per collection). Never inferred from a variance.
 * - `collectionsWithCorrectionsCount` / `collectionsWithOpenDisputesCount` — collections having at
 *   least one correction / OPEN dispute (`EXISTS`, so several rows count the collection once).
 * - `openDisputeCount` — OPEN dispute rows themselves. Today it always equals
 *   `collectionsWithOpenDisputesCount`: a partial unique index allows one OPEN dispute per collection.
 *   Both are reported, counted independently, so neither silently stands in for the other.
 *
 * The conditions overlap; they are not parts of a whole and must not be added together.
 */
export interface CodExceptionSummary {
  /** The database clock at the statement's snapshot. */
  generatedAt: Date;
  collections: {
    total: number;
    /** Every `CodCollectionStatus`, in declaration order, zero-filled. */
    byStatus: Record<CodCollectionStatus, number>;
    outstandingCount: number;
    oldestOutstandingCollectedAt: Date | null;
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

/**
 * Module 08's exported contract for the **read-only COD exception summary**, consumed in-process by
 * Module 16 (module-16 Work 39). One aggregate, nothing per record. It writes nothing.
 */
export interface ICodExceptionSummaryReadPort {
  summarizeExceptions(): Promise<CodExceptionSummary>;
}
