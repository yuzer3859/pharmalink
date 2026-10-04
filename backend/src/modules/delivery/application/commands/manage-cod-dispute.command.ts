import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { AuditService } from '../../../../shared/audit/audit.service';
import { CodCollectionProps } from '../../domain/entities/cod-collection.entity';
import { CodDispute, CodDisputeProps } from '../../domain/entities/cod-dispute.entity';
import { DeliveryErrors } from '../../domain/errors';
import {
  COD_COLLECTION_REPOSITORY,
  ICodCollectionRepository,
} from '../../domain/repositories/cod-collection.repository';
import { IUnitOfWork, UNIT_OF_WORK } from '../ports/unit-of-work.port';
import { runWithDeliveryRetry } from '../support/delivery-retry';

export interface OpenCodDisputeInput {
  /** Module 01 `users.id` of the PharmaLink operator, from the access token. */
  actorUserId: string;
  collectionId: string;
  /** Required. What is actually in question. */
  reason: string;
}

export interface ResolveCodDisputeInput {
  actorUserId: string;
  collectionId: string;
  disputeId: string;
  /** How it ended, in the operator's own words. */
  resolutionNote?: string | null;
}

export interface CodDisputeResult {
  collection: CodCollectionProps;
  dispute: CodDisputeProps;
  /** `false` when this call replayed a dispute already open, or already resolved. */
  created: boolean;
}

/**
 * `ManageCodDispute` (§3.5 F-COD-01, §5) — opening and closing the follow-up on a COD collection.
 *
 * ## The record the reconciliation work had nowhere to put
 *
 * `ReconcileCodCollectionCommand` can find a `DISCREPANCY`, which is a finding somebody has to act
 * on — and there was no record of anybody acting. This is that record: who raised the question,
 * what about, who closed it, and what they concluded.
 *
 * ## Deliberately not a case-management system
 *
 * Two states, two actors, a reason and a note. No queue, no assignee, no SLA, no escalation, no
 * message thread, no attachment (§5). Resolution is **free text rather than an outcome enum**,
 * because an enum would want `RECOVERED`, `WRITTEN_OFF` or `DRIVER_LIABLE` and every one of those
 * answers the commercial question the design's Open Question 5 leaves open. An operator must be
 * able to say what happened without the platform having decided who pays.
 *
 * ## It changes nothing about the money
 *
 * Opening or resolving a dispute writes no amount, moves no status on `cod_collections`, and
 * creates no ledger entry, payable, settlement, payout or driver balance (§7). A collection that
 * was `RECONCILED` stays `RECONCILED` while disputed — "somebody looked" remains true, and the
 * dispute records that the looking is not finished. **Every variance the finance view reports is
 * still computed from the original rows** (§6).
 *
 * ## No event
 *
 * Neither operation writes to the outbox, and that is a decision rather than an omission. A dispute
 * is PharmaLink's internal follow-up state: nothing outside Module 08 acts on it, Module 07 must
 * post nothing on it, and the event catalogue has no COD notification for Module 13 to send.
 * Emitting one would be adding an event because a record exists, which §8 rules out. The audit
 * trail is where both operations are durable.
 *
 * ## Idempotency and concurrency are the database's
 *
 * A **partial** unique index — `cod_disputes(collectionId) WHERE status = 'OPEN'` — makes two
 * operators noticing the same shortfall converge on one dispute, while still allowing a genuinely
 * new dispute months after an earlier one was resolved. A plain unique index would forbid the
 * second, honest dispute; no index would let a busy afternoon produce five copies of the first.
 *
 * Resolution is a compare-and-set on `status`, so the loser of a race is handed the winner's
 * conclusion rather than overwriting it (§10).
 */
@Injectable()
export class ManageCodDisputeCommand {
  constructor(
    @Inject(COD_COLLECTION_REPOSITORY) private readonly collections: ICodCollectionRepository,
    @Inject(UNIT_OF_WORK) private readonly uow: IUnitOfWork,
    private readonly audit: AuditService,
  ) {}

  /**
   * Raises a question about a collection.
   *
   * A collection may be disputed at **any** stage, and that is deliberate: a shortfall is often
   * noticed at the cash desk, before anybody has reconciled anything, and a rule that required
   * `RECONCILED` first would leave the most urgent case with nowhere to be recorded.
   *
   * A second open dispute is not created. The existing one comes back with `created: false`,
   * whatever reason the second caller gave — re-stating the reason would overwrite the first
   * operator's words, and a second row would split one investigation into two.
   */
  async open(input: OpenCodDisputeInput): Promise<CodDisputeResult> {
    const actorUserId = requireText(input.actorUserId, 'actorUserId');
    const collectionId = requireText(input.collectionId, 'collectionId');

    const collection = await this.collections.findById(collectionId);
    if (!collection) {
      throw DeliveryErrors.codCollectionNotFound(collectionId);
    }

    const dispute = CodDispute.open({
      id: randomUUID(),
      collectionId: collection.id,
      reason: input.reason,
      openedByUserId: actorUserId,
    }).toProps();

    // The cheap replay: one indexed read, nothing written.
    const existing = await this.collections.findOpenDispute(collectionId);
    if (existing) {
      return { collection, dispute: existing, created: false };
    }

    const written = await runWithDeliveryRetry(this.uow, async (tx) => {
      const inserted = await this.collections.insertDispute(dispute, tx);
      if (!inserted) {
        // Somebody won the partial unique index. The transaction is aborted, so recovery happens
        // below on a fresh connection, after this one has unwound.
        return null;
      }

      await this.audit.record(
        {
          actorUserId,
          action: 'DELIVERY_COD_DISPUTE_OPENED',
          resourceType: 'CodCollection',
          resourceId: collection.id,
          context: {
            disputeId: inserted.id,
            jobId: collection.jobId,
            orderId: collection.orderId,
            driverId: collection.driverId,
            // The figures as they stood when the question was raised — recorded, not changed, so
            // the trail says what the dispute was about without anybody re-deriving it later.
            expectedAmount: collection.expectedAmount,
            collectedAmount: collection.collectedAmount,
            currency: collection.currency,
            status: collection.status,
            reason: inserted.reason,
          },
        },
        tx,
      );

      return inserted;
    });

    if (written === null) {
      const winner = await this.collections.findOpenDispute(collectionId);
      if (!winner) {
        // The collision was real and the winner is gone — a rollback between the two. Nothing was
        // written by this call either, so the caller retries.
        throw DeliveryErrors.concurrentModification({ collectionId });
      }
      return { collection, dispute: winner, created: false };
    }

    return { collection, dispute: written, created: true };
  }

  /**
   * Closes a dispute, naming who closed it and what they concluded.
   *
   * A dispute that is **already resolved** is replayed rather than refused when the conclusion
   * matches, and refused when it does not: two operators clicking the same button is ordinary, and
   * a second, different conclusion would overwrite the first operator's words (§10).
   */
  async resolve(input: ResolveCodDisputeInput): Promise<CodDisputeResult> {
    const actorUserId = requireText(input.actorUserId, 'actorUserId');
    const collectionId = requireText(input.collectionId, 'collectionId');
    const disputeId = requireText(input.disputeId, 'disputeId');

    const collection = await this.collections.findById(collectionId);
    if (!collection) {
      throw DeliveryErrors.codCollectionNotFound(collectionId);
    }

    const stored = await this.collections.findDisputeById(disputeId);
    if (!stored || stored.collectionId !== collection.id) {
      // A dispute that belongs to another collection answers the same way as one that does not
      // exist, so a dispute id cannot be probed for which collection it hangs off.
      throw DeliveryErrors.codDisputeNotFound(disputeId);
    }

    const resolutionNote = normalizeNote(input.resolutionNote);

    // Already closed — replay the committed conclusion, or refuse a different one. Checked before
    // the entity is asked to transition, because `CodDispute.resolve` refuses a second resolution
    // outright and an ordinary double-click deserves the stored answer rather than a 409.
    if (!CodDispute.rehydrate(stored).isOpen) {
      return this.replayResolved(collection, stored, resolutionNote);
    }

    // Validates the transition and the resulting invariants in one place: a resolved dispute must
    // name who resolved it and when, and an open one must name neither.
    const resolved = CodDispute.rehydrate(stored)
      .resolve({ resolvedByUserId: actorUserId, resolutionNote })
      .toProps();

    const written = await runWithDeliveryRetry(this.uow, async (tx) => {
      const advanced = await this.collections.resolveDispute(
        disputeId,
        {
          resolvedByUserId: resolved.resolvedByUserId as string,
          resolvedAt: resolved.resolvedAt as Date,
          resolutionNote: resolved.resolutionNote,
        },
        tx,
      );
      if (!advanced) {
        // Somebody closed it between the read and the write. Rolling back is the only safe answer:
        // committing an audit entry for a resolution that did not happen would be a false record.
        return null;
      }

      await this.audit.record(
        {
          actorUserId,
          action: 'DELIVERY_COD_DISPUTE_RESOLVED',
          resourceType: 'CodCollection',
          resourceId: collection.id,
          context: {
            disputeId,
            jobId: collection.jobId,
            orderId: collection.orderId,
            driverId: collection.driverId,
            // Both actors, because who raised a question and who closed it is exactly what a
            // dispute trail is read to answer — and they are different people more often than not.
            openedByUserId: stored.openedByUserId,
            reason: stored.reason,
            resolutionNote: resolved.resolutionNote,
            // Unchanged, and stated so the trail shows the money was not touched by the closing.
            expectedAmount: collection.expectedAmount,
            collectedAmount: collection.collectedAmount,
            currency: collection.currency,
          },
        },
        tx,
      );

      return resolved;
    });

    if (written === null) {
      const winner = await this.collections.findDisputeById(disputeId);
      if (!winner) {
        throw DeliveryErrors.codDisputeNotFound(disputeId);
      }
      return this.replayResolved(collection, winner, resolutionNote);
    }

    return { collection, dispute: written, created: true };
  }

  /**
   * What a second resolution of an already-closed dispute means.
   *
   * The same note replays the committed conclusion; a different one is refused. Keeping the first
   * and reporting success would leave an operator believing their conclusion had been recorded.
   */
  private replayResolved(
    collection: CodCollectionProps,
    stored: CodDisputeProps,
    submittedNote: string | null,
  ): CodDisputeResult {
    if (stored.resolutionNote !== submittedNote) {
      throw DeliveryErrors.codDisputeNotOpen(stored.id, stored.status);
    }
    return { collection, dispute: stored, created: false };
  }
}

function normalizeNote(value?: string | null): string | null {
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
