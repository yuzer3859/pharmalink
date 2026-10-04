import { CodCollectionProps } from '../entities/cod-collection.entity';
import { CodCorrectionProps } from '../entities/cod-correction.entity';
import { CodDisputeProps } from '../entities/cod-dispute.entity';
import { CodReconciliationProps } from '../entities/cod-reconciliation.entity';
import { CodRemittanceProps } from '../entities/cod-remittance.entity';
import { CodCollectionStatus, CodDisputeStatus } from '../enums';

export const COD_COLLECTION_REPOSITORY = Symbol('COD_COLLECTION_REPOSITORY');

/**
 * A collection with whatever has happened to it since — the shape every finance read returns.
 *
 * Assembled rather than flattened, so a reader can never mistake which row an amount came from:
 * `collection.collectedAmount` is the driver's declaration, `remittance.remittedAmount` is what
 * PharmaLink received, and the two stay visibly distinct all the way to the HTTP response.
 */
export interface CodCollectionRecord {
  collection: CodCollectionProps;
  /** `null` until an authorized operator has confirmed the handover. */
  remittance: CodRemittanceProps | null;
  /** `null` until an authorized operator has checked it. */
  reconciliation: CodReconciliationProps | null;
  /**
   * Corrections recorded against any of the three rows above, oldest first.
   *
   * Beside the history rather than folded into it: the three records come back exactly as they were
   * written, and these say what any of them should have said. Nothing here is applied to the
   * amounts above, which is what keeps a discrepancy visible after a correction (§6).
   */
  corrections: CodCorrectionProps[];
  /** Disputes raised against this collection, newest first. */
  disputes: CodDisputeProps[];
}

/**
 * The finance surface's filters (§18, §19).
 *
 * Every field narrows; none establishes entitlement — the permission does that, and these reads are
 * platform-wide by design (see `AdminCodReconciliationController`). Deliberately the columns the
 * rows already have: nothing here asks for a figure recomputed at read time, and there is no
 * free-text search that would tempt one.
 *
 * `remittanceReference` is what makes §19's batch grouping work without a batch table — a day's
 * handover shares one handle across every collection in it.
 */
export interface CodCollectionSearchCriteria {
  /** `driver_profiles.id` — "what has this channel been holding?" */
  driverId?: string;
  status?: CodCollectionStatus;
  currency?: string;
  /** Exact match on `cod_remittances.reference`: every collection in one handover. */
  remittanceReference?: string;
  orderId?: string;
  /** Collections whose money changed hands at or after this instant. */
  from?: Date;
  /** ...and at or before this one. */
  to?: Date;
  page: number;
  size: number;
}

/**
 * The same filters as `CodCollectionSearchCriteria` with the paging removed — the summary spans
 * the whole matching population, which is the only thing that makes it a summary.
 */
export type CodCollectionSummaryCriteria = Omit<CodCollectionSearchCriteria, 'page' | 'size'>;

/**
 * Totals over a filtered set of COD collections (§18, §19's grouping).
 *
 * Every number is derived from stored columns. `outstanding` mirrors `isOutstanding` on the item
 * view — not yet `RECONCILED` — and `discrepancy` mirrors `hasDiscrepancy`, so a reader who
 * filters the list by one of them gets a count that matches what they are looking at.
 */
export interface CodCollectionSummary {
  /** How many collections match. */
  count: number;
  /** What the orders said was due, summed. */
  expectedAmount: number;
  /** What drivers declared they took, summed. */
  collectedAmount: number;
  /** What has been handed over to PharmaLink, summed. Unremitted collections contribute nothing. */
  remittedAmount: number;
  /** How many are not yet reconciled. */
  outstandingCount: number;
  /** `collectedAmount` for those, summed — the cash PharmaLink is still waiting to check. */
  outstandingAmount: number;
  /** How many differ from expectation at either the collection or the remittance step. */
  discrepancyCount: number;
}

/**
 * The filters a cross-collection dispute read may narrow by (module-16 Work 06). Each is a column
 * of `cod_disputes`, or of the collection it hangs off — nothing here is a derived attribute and
 * nothing searches the free-text `reason` or `resolutionNote`.
 */
export interface CodDisputeSearchCriteria {
  status?: CodDisputeStatus;
  collectionId?: string;
  /** `driver_profiles.id` of the collection's driver. */
  driverId?: string;
  jobId?: string;
  orderId?: string;
  /** Inclusive lower bound on `openedAt`. */
  openedFrom?: Date;
  /** Exclusive upper bound on `openedAt`. */
  openedTo?: Date;
  /** Inclusive lower bound on `resolvedAt` — implies resolved disputes only. */
  resolvedFrom?: Date;
  /** Exclusive upper bound on `resolvedAt` — implies resolved disputes only. */
  resolvedTo?: Date;
}

/** A dispute with the collection it questions — enough to triage without a second read. */
export interface CodDisputeRecord {
  dispute: CodDisputeProps;
  collection: CodCollectionProps;
}

/** One page of the cross-collection dispute read, newest dispute first. */
export interface CodDisputePage {
  items: CodDisputeRecord[];
  total: number;
  page: number;
  size: number;
}

/** One page of the finance read, newest collection first. */
export interface CodCollectionPage {
  items: CodCollectionRecord[];
  total: number;
  page: number;
  size: number;
}

/**
 * Persistence for the `CodCollection` aggregate (§5.1, §8's `cod_collections`).
 *
 * Domain snapshots in, domain snapshots out — no Prisma type crosses this boundary (ADR-002).
 *
 * ## There is deliberately no `update` and no `delete`
 *
 * "Change how much cash the driver said they took" and "delete the record" remain operations this
 * module cannot express — not operations it merely declines to expose. Every write below is an
 * insert or a guarded one-way status advance; nothing overwrites a figure, a reference or an actor.
 *
 * ## The two transitions, and the promise the COD work made about them
 *
 * That work deliberately shipped no way to reach `REMITTED` or `RECONCILED`, because both are
 * assertions that money reached and was verified by **PharmaLink**, and the only actor with a route
 * anywhere near this aggregate was the driver holding the cash. It said the work implementing the
 * remittance cadence would add the methods it needed *together with the authority allowed to call
 * them*. This is that work, and the pairing is kept: `advanceToRemitted` and `advanceToReconciled`
 * exist, and the only routes that reach them are guarded by `finance:settlement:any`, which no
 * driver role holds and which is granted to nobody who can record a collection.
 *
 * Both are **compare-and-set on the status**, not setters. They refuse from the wrong state rather
 * than writing over it, which is what makes `COLLECTED → RECONCILED` unreachable at the storage
 * layer as well as in the policy, and what lets two concurrent finance officers converge on one
 * winner without a lock.
 *
 * The evidence itself never lands here: amounts, references and the confirming operator live on
 * `cod_remittances` and `cod_reconciliations`, each inserted once behind a unique index. This row
 * keeps only the projection — status and the two timestamps the schema has carried since the COD
 * work — so "what is still outstanding?" stays one indexed scan.
 */
export interface ICodCollectionRepository {
  /**
   * Writes the collection, or reports that the delivery already has one.
   *
   * Returns `null` on a unique-constraint collision rather than throwing, because the collision is
   * an expected outcome: a handset retrying at somebody's door over a bad connection is the
   * ordinary case (§14), and two racing submissions are a case Postgres has to settle because the
   * application cannot.
   *
   * **The re-read must happen outside the transaction.** A unique violation aborts the enclosing
   * Postgres transaction, so a caller that catches the `null` and queries on the same connection
   * fails on the next statement — the defect the proof-of-delivery work found against a real
   * database, and the reason this contract returns rather than throws.
   */
  insert(collection: CodCollectionProps, tx?: unknown): Promise<CodCollectionProps | null>;

  /** The collection for one delivery job, or `null`. The job id is the natural key. */
  findByJobId(jobId: string, tx?: unknown): Promise<CodCollectionProps | null>;

  /** One collection by its own id — how the finance surface addresses it, having no job in hand. */
  findById(collectionId: string, tx?: unknown): Promise<CodCollectionProps | null>;

  /**
   * Advances `COLLECTED → REMITTED`, or reports that the collection was not `COLLECTED`.
   *
   * Compare-and-set: the update names the expected status, so a collection somebody else has
   * already remitted is untouched and `false` comes back. The caller re-reads and returns the
   * established remittance rather than creating a second one (§13).
   */
  advanceToRemitted(collectionId: string, remittedAt: Date, tx?: unknown): Promise<boolean>;

  /**
   * Advances `REMITTED → RECONCILED`, or reports that the collection was not `REMITTED`.
   *
   * The same compare-and-set, and the reason it names `REMITTED` specifically rather than "not yet
   * reconciled" is §5's boundary: a collection still at `COLLECTED` must not become `RECONCILED`,
   * whoever is asking. It also makes the transition one-way — a repeat finds `RECONCILED` and
   * fails the compare, so nothing can move a reconciled collection backward (§12).
   */
  advanceToReconciled(collectionId: string, reconciledAt: Date, tx?: unknown): Promise<boolean>;

  /**
   * Writes the remittance, or reports that the collection already has one.
   *
   * `null` on a unique-constraint collision rather than a throw, for the reason `insert` above
   * gives: the collision is an expected outcome, and **the re-read must happen outside the
   * transaction** because a unique violation aborts the enclosing Postgres transaction.
   */
  insertRemittance(
    remittance: CodRemittanceProps,
    tx?: unknown,
  ): Promise<CodRemittanceProps | null>;

  findRemittanceByCollectionId(
    collectionId: string,
    tx?: unknown,
  ): Promise<CodRemittanceProps | null>;

  /** Writes the reconciliation, or `null` when one already exists. Same contract as above. */
  insertReconciliation(
    reconciliation: CodReconciliationProps,
    tx?: unknown,
  ): Promise<CodReconciliationProps | null>;

  findReconciliationByCollectionId(
    collectionId: string,
    tx?: unknown,
  ): Promise<CodReconciliationProps | null>;

  /** One collection with both of its later legs, for the finance read. */
  findRecordById(collectionId: string, tx?: unknown): Promise<CodCollectionRecord | null>;

  /** The finance list (§18, §19), newest collection first. */
  search(criteria: CodCollectionSearchCriteria): Promise<CodCollectionPage>;

  /**
   * The same query as `search`, counted and summed instead of paged.
   *
   * Takes the identical criteria minus `page`/`size`, so a figure here and the page beside it
   * always describe the same population — a summary computed from different filters than the list
   * it heads is worse than no summary, because it looks authoritative while disagreeing.
   *
   * Sums are ETB minor-unit integers (ADR-005) accumulated in SQL. The aggregate is deliberately
   * thin: counts and totals over columns somebody already wrote, with no rate, no fee, no
   * apportionment and no settlement figure — those would be Module 07's, and a total this module
   * computed would be a second opinion about money it does not own.
   */
  summarize(criteria: CodCollectionSummaryCriteria): Promise<CodCollectionSummary>;

  // -------------------------------------------------------------------------------------------
  // Corrections and disputes — records *beside* the history, never edits to it.
  //
  // There is no `updateCorrection` and no `deleteCorrection`, and there never should be: a
  // correction that could itself be rewritten would put the module back where it started, and a
  // mistaken correction is answered by another correction rather than by an edit.
  //
  // `resolveDispute` is the one exception, and it is a compare-and-set on `status` rather than a
  // setter — it refuses an already-resolved dispute instead of replacing its conclusion.
  // -------------------------------------------------------------------------------------------

  /**
   * Writes a correction, or reports that its `idempotencyKey` is already taken.
   *
   * `null` on the unique-constraint collision rather than a throw, for the reason every other
   * insert here gives: the collision is an expected outcome — a double-submitted form, a retried
   * request whose response was lost, two API nodes racing — and **the re-read must happen outside
   * the transaction**, because a unique violation aborts the enclosing Postgres transaction.
   */
  insertCorrection(
    correction: CodCorrectionProps,
    tx?: unknown,
  ): Promise<CodCorrectionProps | null>;

  /** One correction by its replay key. How a collision is resolved into a replay or a conflict. */
  findCorrectionByIdempotencyKey(
    idempotencyKey: string,
    tx?: unknown,
  ): Promise<CodCorrectionProps | null>;

  /** A collection's corrections, oldest first. */
  listCorrections(collectionId: string, tx?: unknown): Promise<CodCorrectionProps[]>;

  /**
   * Opens a dispute, or reports that this collection already has an open one.
   *
   * `null` on the **partial** unique index `cod_disputes(collectionId) WHERE status = 'OPEN'`. That
   * partiality is what lets two operators noticing the same shortfall converge on one dispute while
   * still allowing a genuinely new dispute months after an earlier one was resolved.
   */
  insertDispute(dispute: CodDisputeProps, tx?: unknown): Promise<CodDisputeProps | null>;

  /** One dispute by id. */
  findDisputeById(disputeId: string, tx?: unknown): Promise<CodDisputeProps | null>;

  /** The collection's open dispute, if it has one. At most one by construction. */
  findOpenDispute(collectionId: string, tx?: unknown): Promise<CodDisputeProps | null>;

  /** A collection's disputes, newest first. */
  listDisputes(collectionId: string, tx?: unknown): Promise<CodDisputeProps[]>;

  /**
   * Disputes across every collection, newest first with `id` as a tiebreaker — the queue an
   * administrator works from. A read of stored columns only; nothing here is a figure recomputed
   * at read time.
   */
  searchDisputes(
    criteria: CodDisputeSearchCriteria,
    page: number,
    size: number,
    tx?: unknown,
  ): Promise<CodDisputePage>;

  /**
   * Closes an open dispute, or reports that it was not open.
   *
   * Compare-and-set on `status = OPEN`: a dispute another operator resolved a millisecond ago is
   * left exactly as they resolved it and `false` comes back, so the loser returns the established
   * conclusion rather than replacing it.
   */
  resolveDispute(
    disputeId: string,
    resolution: { resolvedByUserId: string; resolvedAt: Date; resolutionNote: string | null },
    tx?: unknown,
  ): Promise<boolean>;
}
