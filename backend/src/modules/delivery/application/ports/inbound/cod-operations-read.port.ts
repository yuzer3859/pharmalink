import {
  CodCollectionMethod,
  CodCollectionStatus,
  CodCorrectionType,
  CodDisputeStatus,
  CodReconciliationOutcome,
} from '../../../domain/enums';

export const COD_OPERATIONS_READ_PORT = Symbol('COD_OPERATIONS_READ_PORT');

/** Re-exported so a consumer depends on this one file and not on Module 08's domain layer. */
export {
  CodCollectionMethod,
  CodCollectionStatus,
  CodCorrectionType,
  CodDisputeStatus,
  CodReconciliationOutcome,
} from '../../../domain/enums';

/** Every filter is one `ListCodCollectionsQuery` already applies (`jobId` added for this read). */
export interface CodOperationsFilter {
  status?: CodCollectionStatus;
  orderId?: string;
  jobId?: string;
  /** `collectedAt >= collectedFrom` — Module 08's own period filter, inclusive at both ends. */
  collectedFrom?: Date;
  collectedTo?: Date;
}

/**
 * One COD collection as Module 08's finance read projects it (`toCodReconciliationView`), reduced to
 * identifiers, statuses, amounts and times. Money is integer minor units, signs as Module 08 defines:
 *
 * - `expectedAmount` (frozen from the order), `collectedAmount` (the driver's declaration) and
 *   `remittedAmount` (what reached PharmaLink; `null` until a remittance exists) are three stages and
 *   are never interchangeable.
 * - `collectionVariance` = collected − expected; `remittanceVariance` = remitted − collected, `null`
 *   until remitted. Both from the original rows — a correction never changes them.
 * - `hasDiscrepancy` and `isOutstanding` (status ≠ RECONCILED) are Module 08's definitions.
 *   `reconciliationOutcome` is the recorded finding (`null` until reconciled); it is not inferred.
 *
 * No free text (notes, reasons, references), no provider or settlement reference, no Module 01 user id.
 */
export interface CodOperationsSummary {
  collectionId: string;
  jobId: string;
  orderId: string;
  fulfillmentId: string;
  /** `driver_profiles.id` — opaque; nothing about the person. */
  driverProfileId: string;
  status: CodCollectionStatus;
  method: CodCollectionMethod;
  currency: string;
  expectedAmount: number;
  collectedAmount: number;
  remittedAmount: number | null;
  collectionVariance: number;
  remittanceVariance: number | null;
  hasDiscrepancy: boolean;
  isOutstanding: boolean;
  reconciliationOutcome: CodReconciliationOutcome | null;
  collectedAt: Date;
  recordedAt: Date;
  remittedAt: Date | null;
  reconciledAt: Date | null;
  correctionCount: number;
  disputeCount: number;
  openDisputeCount: number;
}

export interface CodOperationsPage {
  items: CodOperationsSummary[];
  total: number;
  page: number;
  size: number;
}

export interface CodOperationsDetail extends CodOperationsSummary {
  /** At most one per collection (`cod_remittances.collectionId` is unique). */
  remittance: { remittanceId: string; remittedAmount: number; currency: string; remittedAt: Date; recordedAt: Date } | null;
  /** At most one per collection (`cod_reconciliations.collectionId` is unique). */
  reconciliation: { reconciliationId: string; outcome: CodReconciliationOutcome; reconciledAt: Date } | null;
  /**
   * Every correction, oldest first. Recorded beside the original facts and applied to nothing:
   * `originalAmount`/`correctedAmount` are what the record said and should have said (both `null`
   * unless an amount was corrected). No net amount is derived from them.
   */
  corrections: Array<{
    correctionId: string;
    type: CodCorrectionType;
    remittanceId: string | null;
    reconciliationId: string | null;
    originalAmount: number | null;
    correctedAmount: number | null;
    createdAt: Date;
  }>;
  /** Every dispute, newest first — reference and state only. */
  disputes: Array<{ disputeId: string; status: CodDisputeStatus; openedAt: Date; resolvedAt: Date | null }>;
}

/**
 * Module 08's exported contract for **read-only COD operations**, consumed in-process by Module 16
 * (module-16 Work 38). The list is `ListCodCollectionsQuery.execute`; the detail reads the same
 * record `ListCodCollectionsQuery.byId` does, in one REPEATABLE READ snapshot. Both apply Module 08's
 * own projection. It writes nothing.
 */
export interface ICodOperationsReadPort {
  listCollections(filter: CodOperationsFilter, page: number, size: number): Promise<CodOperationsPage>;

  /** `null` when no collection has this id. */
  getCollection(collectionId: string): Promise<CodOperationsDetail | null>;
}
