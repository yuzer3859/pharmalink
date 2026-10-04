import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { AuditService } from '../../../../shared/audit/audit.service';
import { OutboxCapableClient, OutboxService } from '../../../../shared/outbox/outbox.service';
import { CodCollectionProps } from '../../domain/entities/cod-collection.entity';
import {
  amountDeltaOf,
  CodCorrection,
  CodCorrectionProps,
} from '../../domain/entities/cod-correction.entity';
import { CodCorrectionType } from '../../domain/enums';
import { codCorrectionRecordedEvent } from '../../domain/events';
import { DeliveryErrors } from '../../domain/errors';
import {
  COD_COLLECTION_REPOSITORY,
  ICodCollectionRepository,
} from '../../domain/repositories/cod-collection.repository';
import { IUnitOfWork, UNIT_OF_WORK } from '../ports/unit-of-work.port';
import { runWithDeliveryRetry } from '../support/delivery-retry';

export interface RecordCodCorrectionInput {
  /** Module 01 `users.id` of the PharmaLink operator, from the access token. */
  actorUserId: string;
  collectionId: string;
  type: CodCorrectionType;
  /** Set when the correction is about the handover rather than the collection itself. */
  remittanceId?: string | null;
  /** Set when the correction is about the finding. */
  reconciliationId?: string | null;
  /** Minor units. Required for a recording mistake, refused for every other type. */
  originalAmount?: number | null;
  correctedAmount?: number | null;
  /** Required for a reference correction, refused for every other type. */
  originalReference?: string | null;
  correctedReference?: string | null;
  /** Required, always. */
  reason: string;
  /** The caller-supplied replay key (§9). */
  idempotencyKey: string;
}

export interface RecordCodCorrectionResult {
  collection: CodCollectionProps;
  correction: CodCorrectionProps;
  /** `correctedAmount − originalAmount`, or `null`. Applied to nothing. */
  amountDelta: number | null;
  /** `false` when this call replayed a correction already recorded under the same key. */
  created: boolean;
}

/**
 * `RecordCodCorrection` (§3.5 F-COD-01, the design's Open Question 5) — records that a COD record
 * was wrong, **beside** it rather than onto it.
 *
 * ## Why a command rather than an update
 *
 * The COD collection, remittance and reconciliation works each shipped a record with no update path
 * at all, on purpose: a driver's declaration about a customer's money and an operator's
 * confirmation that it arrived are evidence, and evidence that can be edited is not evidence. All
 * three works said the same thing about the gap that leaves — that a correction is a new auditable
 * adjustment under a workflow deciding who may restate a fact. This is that workflow.
 *
 * It takes the shape the project already has for a fact that cannot be undone: Module 07's `refunds`
 * against a payment it cannot un-charge — a compensating record with a reason, an actor and a
 * caller-supplied replay key behind a unique index.
 *
 * ## What it never touches
 *
 * `collectedAmount`, `expectedAmount`, `remittedAmount`, the collection method, any reference, any
 * timestamp, and the collection's position in `COLLECTED → REMITTED → RECONCILED` — none of them is
 * written here, and the repository offers no method that could. No ledger entry, no `Payment`, no
 * wallet, no settlement, no payout, no driver balance (§7).
 *
 * **And no discrepancy disappears.** Every variance the finance view reports is still computed from
 * the original rows, with corrections listed alongside them: `original fact + correction` is the
 * history rather than a replacement for it (§6). `amountDelta` says how far a record was out; it is
 * applied to nothing, and nothing downstream is instructed to apply it.
 *
 * ## What it refuses to decide
 *
 * Who absorbs a shortfall. There is no correction type that writes money off, recovers it from a
 * driver, or charges anybody — `CodCorrectionType` has four values and every one of them names a
 * mistake in the *record*. The commercial rule is the design's Open Question 5 and this command
 * does not settle it on anybody's behalf.
 *
 * ## Order of operations
 *
 * 1. **Validate** the type against its value pair — in the entity, so a `RECORDING_MISTAKE` with no
 *    numbers is unconstructable rather than merely discouraged.
 * 2. **Find the collection**, and the remittance or reconciliation the correction names. A record
 *    belonging to a *different* collection is refused: attaching a correction to another driver's
 *    handover would put a statement about one driver's cash into another driver's trail.
 * 3. **Short-circuit on the replay key** — read before anything is written, so a double-submitted
 *    form costs one indexed read.
 * 4. **Write the correction, its audit entry and `CodCorrectionRecorded`**, together, in one
 *    `Serializable` transaction.
 *
 * ## Idempotency is the database's
 *
 * `cod_corrections.idempotencyKey` is unique. A correction has no natural key — two different
 * corrections of the same type against the same collection are both legitimate — so identity is
 * caller-supplied, exactly as `orders.idempotencyKey` and `payments.idempotencyKey` are. A repeat
 * has three outcomes:
 *
 *  - **same correction** — returns the stored one with `created: false`: no second row, no second
 *    audit entry, no second event.
 *  - **different correction under the same key** — `IDEMPOTENCY_CONFLICT`. Returning the first
 *    would leave an operator believing a correction had been filed that had not.
 *  - **nothing stored** — the ordinary first recording.
 *
 * The collision recovery re-reads on a **fresh connection, outside the transaction**, because a
 * unique violation aborts the enclosing Postgres transaction.
 */
@Injectable()
export class RecordCodCorrectionCommand {
  constructor(
    @Inject(COD_COLLECTION_REPOSITORY) private readonly collections: ICodCollectionRepository,
    @Inject(UNIT_OF_WORK) private readonly uow: IUnitOfWork,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  async execute(input: RecordCodCorrectionInput): Promise<RecordCodCorrectionResult> {
    const actorUserId = requireText(input.actorUserId, 'actorUserId');
    const collectionId = requireText(input.collectionId, 'collectionId');

    const collection = await this.collections.findById(collectionId);
    if (!collection) {
      throw DeliveryErrors.codCollectionNotFound(collectionId);
    }

    const subject = await this.resolveSubject(collection, input);

    // Built before the replay lookup so a malformed correction is refused on a replay too — a
    // caller who fixes their key but not their body should not be told the record was accepted.
    const correction = CodCorrection.record({
      id: randomUUID(),
      collectionId: collection.id,
      remittanceId: subject.remittanceId,
      reconciliationId: subject.reconciliationId,
      type: input.type,
      originalAmount: input.originalAmount ?? null,
      correctedAmount: input.correctedAmount ?? null,
      originalReference: input.originalReference ?? null,
      correctedReference: input.correctedReference ?? null,
      reason: input.reason,
      idempotencyKey: input.idempotencyKey,
      createdByUserId: actorUserId,
    }).toProps();

    // The cheap replay: one indexed read, nothing written, no event.
    const existing = await this.collections.findCorrectionByIdempotencyKey(
      correction.idempotencyKey,
    );
    if (existing) {
      return this.resolveExisting(collection, existing, correction);
    }

    const written = await runWithDeliveryRetry(this.uow, async (tx) => {
      const inserted = await this.collections.insertCorrection(correction, tx);
      if (!inserted) {
        // Somebody won the unique index. The transaction is aborted, so recovery happens below on
        // a fresh connection, after this one has unwound.
        return null;
      }

      await this.audit.record(
        {
          // The PharmaLink operator, never the driver whose collection is being corrected.
          actorUserId,
          action: 'DELIVERY_COD_CORRECTION_RECORDED',
          resourceType: 'CodCollection',
          resourceId: collection.id,
          context: {
            correctionId: inserted.id,
            remittanceId: inserted.remittanceId,
            reconciliationId: inserted.reconciliationId,
            jobId: collection.jobId,
            orderId: collection.orderId,
            fulfillmentId: collection.fulfillmentId,
            driverId: collection.driverId,
            type: inserted.type,
            // Both halves of every pair, because a correction that recorded only the new value
            // would be indistinguishable in the trail from an edit — which is the one thing this
            // table exists to avoid looking like.
            originalAmount: inserted.originalAmount,
            correctedAmount: inserted.correctedAmount,
            amountDelta: amountDeltaOf(inserted),
            originalReference: inserted.originalReference,
            correctedReference: inserted.correctedReference,
            currency: collection.currency,
            reason: inserted.reason,
          },
        },
        tx,
      );

      await this.outbox.write(
        codCorrectionRecordedEvent({
          correctionId: inserted.id,
          collectionId: collection.id,
          remittanceId: inserted.remittanceId,
          reconciliationId: inserted.reconciliationId,
          jobId: collection.jobId,
          orderId: collection.orderId,
          fulfillmentId: collection.fulfillmentId,
          driverId: collection.driverId,
          type: inserted.type,
          originalAmount: inserted.originalAmount,
          correctedAmount: inserted.correctedAmount,
          originalReference: inserted.originalReference,
          correctedReference: inserted.correctedReference,
          currency: collection.currency,
          reason: inserted.reason,
          createdByUserId: inserted.createdByUserId,
          createdAt: inserted.createdAt.toISOString(),
        }),
        tx as OutboxCapableClient,
      );

      return inserted;
    });

    if (written === null) {
      const winner = await this.collections.findCorrectionByIdempotencyKey(
        correction.idempotencyKey,
      );
      if (!winner) {
        // The collision was real and the winner is gone — a rollback between the two. Nothing was
        // written by this call either, so reporting the refusal is honest and the caller retries.
        throw DeliveryErrors.codCorrectionIdempotencyConflict(correction.idempotencyKey);
      }
      return this.resolveExisting(collection, winner, correction);
    }

    return {
      // Re-read rather than assumed — and the point of the re-read is that it comes back
      // *unchanged*: recording a correction moves no status and rewrites no amount.
      collection: (await this.collections.findById(collectionId)) ?? collection,
      correction: written,
      amountDelta: amountDeltaOf(written),
      created: true,
    };
  }

  /**
   * Resolves which record the correction is about, and refuses one that is not this collection's.
   *
   * A reconciliation-mistake correction must name a reconciliation — the entity insists — and the
   * named record must exist *and* belong here. Attaching a correction to another collection's
   * remittance would file a statement about one driver's cash in another driver's trail, which is
   * worse than refusing the request.
   */
  private async resolveSubject(
    collection: CodCollectionProps,
    input: RecordCodCorrectionInput,
  ): Promise<{ remittanceId: string | null; reconciliationId: string | null }> {
    const remittanceId = normalize(input.remittanceId);
    const reconciliationId = normalize(input.reconciliationId);

    if (remittanceId) {
      const remittance = await this.collections.findRemittanceByCollectionId(collection.id);
      if (!remittance) {
        throw DeliveryErrors.codCorrectionSubjectMissing(collection.id, 'remittance');
      }
      if (remittance.id !== remittanceId) {
        throw DeliveryErrors.codCorrectionSubjectMismatch(collection.id, { remittanceId });
      }
    }

    if (reconciliationId) {
      const reconciliation = await this.collections.findReconciliationByCollectionId(collection.id);
      if (!reconciliation) {
        throw DeliveryErrors.codCorrectionSubjectMissing(collection.id, 'reconciliation');
      }
      if (reconciliation.id !== reconciliationId) {
        throw DeliveryErrors.codCorrectionSubjectMismatch(collection.id, { reconciliationId });
      }
    }

    return { remittanceId, reconciliationId };
  }

  /**
   * Decides what a submission under an already-used replay key means.
   *
   * Everything the operator stated is compared — the subject, the type, both value pairs and the
   * reason. A match is a form resubmitted or a request retried and replays the stored correction. A
   * mismatch is a *different* correction wearing the same key, and is refused: silently returning
   * the first would leave an operator believing their second correction had been filed.
   *
   * `createdByUserId` is deliberately not compared. Two operators submitting the identical
   * correction under one key is a shared-console retry, and the committed record keeps the operator
   * who actually filed it.
   */
  private resolveExisting(
    collection: CodCollectionProps,
    stored: CodCorrectionProps,
    submitted: CodCorrectionProps,
  ): RecordCodCorrectionResult {
    const same =
      stored.collectionId === submitted.collectionId &&
      stored.remittanceId === submitted.remittanceId &&
      stored.reconciliationId === submitted.reconciliationId &&
      stored.type === submitted.type &&
      stored.originalAmount === submitted.originalAmount &&
      stored.correctedAmount === submitted.correctedAmount &&
      stored.originalReference === submitted.originalReference &&
      stored.correctedReference === submitted.correctedReference &&
      stored.reason === submitted.reason;

    if (!same) {
      throw DeliveryErrors.codCorrectionIdempotencyConflict(stored.idempotencyKey);
    }

    return {
      collection,
      correction: stored,
      amountDelta: amountDeltaOf(stored),
      created: false,
    };
  }
}

function normalize(value?: string | null): string | null {
  const text = typeof value === 'string' ? value.trim() : '';
  return text.length === 0 ? null : text;
}

function requireText(value: string, field: string): string {
  const text = (value ?? '').trim();
  if (!text) {
    throw DeliveryErrors.validation(`${field} is required.`, { field });
  }
  return text;
}
