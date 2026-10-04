import { RecordCodRemittanceResult } from '../../application/commands/record-cod-remittance.command';
import { ReconcileCodCollectionResult } from '../../application/commands/reconcile-cod-collection.command';
import {
  CodReconciliationPageView,
  CodReconciliationView,
} from '../../application/queries/list-cod-collections.query';
import {
  amountDeltaOf,
  CodCorrectionProps,
} from '../../domain/entities/cod-correction.entity';
import { CodDisputeProps } from '../../domain/entities/cod-dispute.entity';
import { CodCollectionSummary } from '../../domain/repositories/cod-collection.repository';
import { CodReconciliationProps } from '../../domain/entities/cod-reconciliation.entity';
import { CodRemittanceProps } from '../../domain/entities/cod-remittance.entity';

/**
 * The handover, as finance reads it back.
 *
 * `confirmedByUserId` is a Module 01 user id and nothing else — no name, no phone, no role. Who an
 * operator *is* is Module 01's to answer, and a delivery response that carried a staff member's
 * contact details would be a second home for facts another module owns.
 *
 * `reference` is a PharmaLink-side handle and is not a secret: it is a deposit slip or a cash-office
 * batch label, exactly the thing a human quotes while reconciling. There is no provider payload,
 * signature, callback body, account number or token anywhere in this shape, because none of it is
 * ever accepted anywhere upstream of it.
 */
export interface CodRemittanceResponse {
  id: string;
  /** Minor units (ADR-005): what actually reached PharmaLink. */
  remittedAmount: number;
  currency: string;
  /** The generic PharmaLink-side handle for this handover. Shared across a batch. */
  reference: string;
  note: string | null;
  /** Module 01 `users.id` of the operator who confirmed it — §18's "who recorded each step?". */
  confirmedByUserId: string;
  /** ISO-8601 — when the money changed hands, and when the platform recorded it. */
  remittedAt: string;
  recordedAt: string;
}

/**
 * The finding.
 *
 * `outcome` is the platform's determination, computed from the amounts. A client cannot have
 * supplied it and cannot change it; `DISCREPANCY` says the amounts did not agree and says nothing
 * at all about who absorbs the difference.
 */
export interface CodReconciliationResponse {
  id: string;
  /** `ACCEPTED` or `DISCREPANCY`. */
  outcome: string;
  /** The reconciliation run's own generic handle, where the operator gave one. */
  reference: string | null;
  note: string | null;
  /** Module 01 `users.id` of the operator who reconciled it. */
  reconciledByUserId: string;
  reconciledAt: string;
}

/**
 * One COD collection with everything that has happened to it (§18).
 *
 * ## Three legs, three nested objects, and no flattening
 *
 * `collectedAmount`, `remittance.remittedAmount` and the two variances stay visibly distinct all
 * the way out to the wire. Flattening them into one `amount` — or worse, into a single `paid`
 * boolean — is exactly the collapse the COD work refused when it replaced the Phase-0 `reconciled`
 * column: three assertions by three parties are not one fact, and a reader must never have to guess
 * which row a figure came from.
 *
 * `remittance` and `reconciliation` are `null` until they happen, which is what makes "what remains
 * to be reconciled?" answerable by looking rather than by inferring.
 *
 * ## What it does not carry
 *
 * No driver name, phone, bank detail, earnings figure or payout history — `driverId` is a
 * `driver_profiles.id` and that is the whole of what finance is told about the channel (§18). No
 * customer detail. No settlement, payable or ledger field, because this module has none (§15).
 */
export interface CodReconciliationDetailResponse {
  id: string;
  jobId: string;
  orderId: string;
  fulfillmentId: string;
  /** `driver_profiles.id` of the collection channel. No Module 01 identity is exposed. */
  driverId: string;
  /** What the order came to, frozen on the job. */
  expectedAmount: number;
  /** What the driver declared receiving. */
  collectedAmount: number;
  currency: string;
  /** `CASH` or `ELECTRONIC`. Never a provider name. */
  method: string;
  /** `COLLECTED`, `REMITTED` or `RECONCILED`. */
  status: string;
  /** The collection's opaque transaction reference, or `null`. */
  providerReference: string | null;
  collectedAt: string;
  recordedAt: string;
  /** `collectedAmount − expectedAmount`. */
  collectionVariance: number;
  /** `remittedAmount − collectedAmount`, or `null` while nothing has been remitted. */
  remittanceVariance: number | null;
  hasDiscrepancy: boolean;
  /** Whether PharmaLink still owes this collection a step. */
  isOutstanding: boolean;
  remittance: CodRemittanceResponse | null;
  reconciliation: CodReconciliationResponse | null;
  /**
   * What any of the three records above should have said, oldest first (§11).
   *
   * **Beside the history, not folded into it.** Every figure and every variance above is exactly
   * what was recorded at the time, corrections or no corrections — so a shortfall stays as visible
   * after one as it was before (§6). A reader sees the original fact and the correction, and the
   * two together are the history.
   */
  corrections: CodCorrectionResponse[];
  /** Questions raised about this collection, newest first. */
  disputes: CodDisputeResponse[];
}

/**
 * The same collection without its correction history.
 *
 * What a remit or reconcile call reports back: those commands act on the three-step lifecycle and
 * load nothing about corrections or disputes, so their response says nothing about them rather than
 * claiming an empty list. An empty `corrections: []` on a remit response would read as "this
 * collection has never been corrected", which the command has not checked and cannot say.
 */
export type CodCollectionLifecycleResponse = Omit<
  CodReconciliationDetailResponse,
  'corrections' | 'disputes'
>;

/**
 * One correction, as finance reads it back.
 *
 * Both halves of whichever pair the type used, plus `amountDelta` — how far the record was out.
 * The delta is **applied to nothing**: it is a fact about the mistake, not an adjustment anybody is
 * instructed to post, and no field here says who absorbs a difference.
 *
 * `createdByUserId` is a Module 01 user id and nothing more — no name, no phone, no role.
 */
export interface CodCorrectionResponse {
  id: string;
  /** Which record this corrects, when it is not the collection itself. */
  remittanceId: string | null;
  reconciliationId: string | null;
  /** One of the four `CodCorrectionType` values. */
  type: string;
  /** Minor units. Both null for a non-monetary correction. */
  originalAmount: number | null;
  correctedAmount: number | null;
  /** `correctedAmount − originalAmount`, or `null`. Derived, and applied to nothing. */
  amountDelta: number | null;
  /** Both null for a non-reference correction. Opaque handles, never provider payloads. */
  originalReference: string | null;
  correctedReference: string | null;
  reason: string;
  /** Module 01 `users.id` of the operator who recorded it — never the driver. */
  createdByUserId: string;
  createdAt: string;
}

/**
 * One dispute.
 *
 * `resolutionNote` is free text rather than an outcome code, deliberately: a resolution must be
 * able to say what happened without the platform having decided who pays.
 */
export interface CodDisputeResponse {
  id: string;
  reason: string;
  /** `OPEN` or `RESOLVED`. */
  status: string;
  openedByUserId: string;
  openedAt: string;
  resolvedByUserId: string | null;
  resolvedAt: string | null;
  resolutionNote: string | null;
}

/** The correction response. `created` distinguishes a first recording from an idempotent replay. */
export interface RecordCodCorrectionResponse {
  created: boolean;
  collection: CodCollectionLifecycleResponse;
  correction: CodCorrectionResponse;
}

/** The dispute response, for both opening and resolving. */
export interface CodDisputeMutationResponse {
  created: boolean;
  collection: CodCollectionLifecycleResponse;
  dispute: CodDisputeResponse;
}

export interface CodReconciliationPageResponse {
  items: CodReconciliationDetailResponse[];
  total: number;
  page: number;
  size: number;
}

/**
 * The remit response.
 *
 * `created` distinguishes "this call recorded the handover" from "the handover was already recorded
 * and this call matched it". A finance console that retried after a timeout deserves to know which,
 * and an auditor reading the log needs to.
 *
 * `outcome` and `variance` are about the *remittance* — how what arrived compares with what the
 * driver declared. They are emphatically not a reconciliation: `status` will read `REMITTED`, and
 * §4's "do not mark the collection `RECONCILED` merely because a remittance was recorded" is
 * visible right here in the response.
 */
export interface RecordCodRemittanceResponse {
  created: boolean;
  /** `EXACT`, `SHORT` or `OVER`. */
  outcome: string;
  /** `remittedAmount − collectedAmount`. Negative is a shortfall. */
  variance: number;
  collection: CodCollectionLifecycleResponse;
}

/** The reconcile response. `created` carries the same meaning as above. */
export interface ReconcileCodCollectionResponse {
  created: boolean;
  collection: CodCollectionLifecycleResponse;
}

export function toCodReconciliationDetailResponse(
  view: CodReconciliationView,
): CodReconciliationDetailResponse {
  return {
    ...toLifecycleResponse(view),
    corrections: view.corrections.map(toCorrectionResponse),
    disputes: view.disputes.map(toDisputeResponse),
  };
}

function toLifecycleResponse(
  view: Omit<CodReconciliationView, 'corrections' | 'disputes'>,
): CodCollectionLifecycleResponse {
  const { collection } = view;
  return {
    id: collection.id,
    jobId: collection.jobId,
    orderId: collection.orderId,
    fulfillmentId: collection.fulfillmentId,
    driverId: collection.driverId,
    expectedAmount: collection.expectedAmount,
    collectedAmount: collection.collectedAmount,
    currency: collection.currency,
    method: collection.method,
    status: collection.status,
    providerReference: collection.providerReference,
    collectedAt: collection.collectedAt.toISOString(),
    recordedAt: collection.recordedAt.toISOString(),
    collectionVariance: view.collectionVariance,
    remittanceVariance: view.remittanceVariance,
    hasDiscrepancy: view.hasDiscrepancy,
    isOutstanding: view.isOutstanding,
    remittance: view.remittance ? toRemittanceResponse(view.remittance) : null,
    reconciliation: view.reconciliation ? toReconciliationResponse(view.reconciliation) : null,
  };
}

export function toCodReconciliationPageResponse(
  page: CodReconciliationPageView,
): CodReconciliationPageResponse {
  return {
    items: page.items.map(toCodReconciliationDetailResponse),
    total: page.total,
    page: page.page,
    size: page.size,
  };
}

export function toRecordCodRemittanceResponse(
  result: RecordCodRemittanceResult,
): RecordCodRemittanceResponse {
  return {
    created: result.created,
    outcome: result.outcome,
    variance: result.variance,
    collection: toLifecycleResponse({
      collection: result.collection,
      remittance: result.remittance,
      // Null by construction: a collection that has just been remitted has not been reconciled, and
      // §4 is explicit that recording a remittance must not imply one.
      reconciliation: null,
      collectionVariance: result.collection.collectedAmount - result.collection.expectedAmount,
      remittanceVariance: result.variance,
      hasDiscrepancy:
        result.collection.collectedAmount !== result.collection.expectedAmount ||
        result.variance !== 0,
      isOutstanding: true,
    }),
  };
}

export function toReconcileCodCollectionResponse(
  result: ReconcileCodCollectionResult,
): ReconcileCodCollectionResponse {
  return {
    created: result.created,
    collection: toLifecycleResponse({
      collection: result.collection,
      remittance: result.remittance,
      reconciliation: result.reconciliation,
      collectionVariance: result.collectionVariance,
      remittanceVariance: result.remittanceVariance,
      hasDiscrepancy: result.collectionVariance !== 0 || result.remittanceVariance !== 0,
      // A reconciled collection is no longer outstanding whatever the finding was: somebody looked.
      // `hasDiscrepancy` is what a follow-up queue filters on, not this.
      isOutstanding: false,
    }),
  };
}

export function toCodCorrectionResponse(
  correction: CodCorrectionProps,
): CodCorrectionResponse {
  return toCorrectionResponse(correction);
}

export function toCodDisputeResponse(dispute: CodDisputeProps): CodDisputeResponse {
  return toDisputeResponse(dispute);
}

/**
 * The lifecycle half of a collection, for a correction or dispute response.
 *
 * Its figures are the **original** ones and stay that way: a correction response reports the record
 * as it stands plus the correction as a separate object, never the record as it would look if
 * somebody applied the correction to it.
 */
export function toCodCollectionLifecycleResponse(
  view: Omit<CodReconciliationView, 'corrections' | 'disputes'>,
): CodCollectionLifecycleResponse {
  return toLifecycleResponse(view);
}

function toCorrectionResponse(correction: CodCorrectionProps): CodCorrectionResponse {
  return {
    id: correction.id,
    remittanceId: correction.remittanceId,
    reconciliationId: correction.reconciliationId,
    type: correction.type,
    originalAmount: correction.originalAmount,
    correctedAmount: correction.correctedAmount,
    amountDelta: amountDeltaOf(correction),
    originalReference: correction.originalReference,
    correctedReference: correction.correctedReference,
    reason: correction.reason,
    createdByUserId: correction.createdByUserId,
    createdAt: correction.createdAt.toISOString(),
  };
}

function toDisputeResponse(dispute: CodDisputeProps): CodDisputeResponse {
  return {
    id: dispute.id,
    reason: dispute.reason,
    status: dispute.status,
    openedByUserId: dispute.openedByUserId,
    openedAt: dispute.openedAt.toISOString(),
    resolvedByUserId: dispute.resolvedByUserId,
    resolvedAt: dispute.resolvedAt ? dispute.resolvedAt.toISOString() : null,
    resolutionNote: dispute.resolutionNote,
  };
}

function toRemittanceResponse(remittance: CodRemittanceProps): CodRemittanceResponse {
  return {
    id: remittance.id,
    remittedAmount: remittance.remittedAmount,
    currency: remittance.currency,
    reference: remittance.reference,
    note: remittance.note,
    confirmedByUserId: remittance.confirmedByUserId,
    remittedAt: remittance.remittedAt.toISOString(),
    recordedAt: remittance.recordedAt.toISOString(),
  };
}

function toReconciliationResponse(
  reconciliation: CodReconciliationProps,
): CodReconciliationResponse {
  return {
    id: reconciliation.id,
    outcome: reconciliation.outcome,
    reference: reconciliation.reference,
    note: reconciliation.note,
    reconciledByUserId: reconciliation.reconciledByUserId,
    reconciledAt: reconciliation.reconciledAt.toISOString(),
  };
}

/**
 * Totals over a filtered set of COD collections (§18, §19's grouping).
 *
 * Amounts are ETB minor-unit integers (ADR-005), the same units as every figure on the rows they
 * summarise — a summary that changed units would be the single most expensive kind of bug this
 * module could ship.
 *
 * There is deliberately **no settlement figure, no fee, no payout and no net**. Every number here
 * is a count or a sum of a column somebody wrote down; the moment one of them became a figure
 * Delivery *calculated* about what is owed, this module would be keeping a second set of books
 * beside Module 07's, and the two would eventually disagree.
 */
export interface CodCollectionSummaryResponse {
  count: number;
  expectedAmount: number;
  collectedAmount: number;
  remittedAmount: number;
  outstandingCount: number;
  outstandingAmount: number;
  discrepancyCount: number;
}

export function toCodCollectionSummaryResponse(
  summary: CodCollectionSummary,
): CodCollectionSummaryResponse {
  return {
    count: summary.count,
    expectedAmount: summary.expectedAmount,
    collectedAmount: summary.collectedAmount,
    remittedAmount: summary.remittedAmount,
    outstandingCount: summary.outstandingCount,
    outstandingAmount: summary.outstandingAmount,
    discrepancyCount: summary.discrepancyCount,
  };
}
