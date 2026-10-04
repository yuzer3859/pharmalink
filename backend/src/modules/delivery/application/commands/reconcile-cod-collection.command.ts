import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { AuditService } from '../../../../shared/audit/audit.service';
import { OutboxCapableClient, OutboxService } from '../../../../shared/outbox/outbox.service';
import { CodCollectionProps, varianceOf } from '../../domain/entities/cod-collection.entity';
import {
  CodReconciliation,
  CodReconciliationProps,
} from '../../domain/entities/cod-reconciliation.entity';
import {
  CodRemittanceProps,
  MAX_REMITTANCE_NOTE_LENGTH,
  MAX_REMITTANCE_REFERENCE_LENGTH,
} from '../../domain/entities/cod-remittance.entity';
import { CodReconciliationOutcome } from '../../domain/enums';
import { codReconciledEvent } from '../../domain/events';
import { DeliveryErrors } from '../../domain/errors';
import {
  COD_COLLECTION_REPOSITORY,
  ICodCollectionRepository,
} from '../../domain/repositories/cod-collection.repository';
import { CodCollectionPolicy } from '../../domain/services/cod-collection-policy';
import { IUnitOfWork, UNIT_OF_WORK } from '../ports/unit-of-work.port';
import { runWithDeliveryRetry } from '../support/delivery-retry';

export interface ReconcileCodCollectionInput {
  /** Module 01 `users.id` of the PharmaLink operator, from the access token. */
  actorUserId: string;
  collectionId: string;
  /** An optional generic handle for the reconciliation run itself. */
  reference?: string | null;
  /** What the operator wants the next reader to know, where the outcome is a difference. */
  note?: string | null;
}

export interface ReconcileCodCollectionResult {
  collection: CodCollectionProps;
  remittance: CodRemittanceProps;
  reconciliation: CodReconciliationProps;
  /** `collectedAmount − expectedAmount`. What the customer paid against what was due. */
  collectionVariance: number;
  /** `remittedAmount − collectedAmount`. What arrived against what was declared. */
  remittanceVariance: number;
  /** `false` when this call matched a reconciliation already recorded — an idempotent replay. */
  created: boolean;
}

/**
 * `ReconcileCodCollection` (§3.5 F-COD-01, §5, §9.5's `/admin/delivery/cod-reconciliation`) — an
 * authorized PharmaLink operator checking a remittance against the collection it was supposed to
 * cover, and recording what they found.
 *
 * ## `REMITTED → RECONCILED`, and nothing else
 *
 * The lifecycle boundary §5 requires is enforced in three places, and the redundancy is deliberate:
 * `CodCollectionPolicy.isReconciliationAllowedIn` names `REMITTED` and only `REMITTED`;
 * `ICodCollectionRepository.advanceToReconciled` compare-and-sets on the same value; and the
 * reconciliation row cannot be written without a remittance row to point at.
 *
 * **`COLLECTED → RECONCILED` is therefore unreachable, not merely discouraged.** It would mean
 * PharmaLink certifying money it has not been handed, on the word of the channel still holding it —
 * the single thing the whole three-step lifecycle exists to prevent — and no permission check is a
 * substitute for the shortcut simply not existing. A finance officer with every permission in the
 * catalogue cannot reconcile an unremitted collection.
 *
 * ## The outcome is computed, never supplied
 *
 * There is no `outcome` field on the input and no DTO field that could carry one.
 * `CodCollectionPolicy.classifyReconciliation` derives it from the three amounts, and `ACCEPTED`
 * requires **both** gaps to be zero: what the customer paid must have matched what the order came
 * to, *and* what arrived must have matched what the driver declared.
 *
 * That second condition catches a case worth naming. A driver who collected 20,000 against a 24,500
 * order and then faithfully remitted 20,000 has an honest remittance and a dishonest total — the
 * platform is still 4,500 short. A model that reconciled against the remittance alone would mark
 * that clean.
 *
 * ## A discrepancy is recorded, not refused
 *
 * Both outcomes write a row and both advance the collection to `RECONCILED`. `RECONCILED` means
 * "PharmaLink has looked at this", not "this was fine" — `outcome` says which, and a `DISCREPANCY`
 * row is the finding that somebody has to act on rather than a failure of the check.
 *
 * Refusing instead would be worse in the way §6 names: a mismatch that is merely rejected leaves no
 * record that anybody ever examined it, and the collection sits at `REMITTED` indistinguishable
 * from one nobody has got to yet. Marking it `ACCEPTED` would be worse still — a fake successful
 * payment so the paperwork closes.
 *
 * What the command does **not** do is decide who absorbs the difference. Recovering it from the
 * driver, absorbing it, chasing the customer, writing it off: all commercial and possibly
 * disciplinary decisions, none of them taken anywhere in this repository (the design's Open
 * Question 5), and none of them invented here.
 *
 * ## What it does not touch
 *
 * No ledger entry, no `COD_CLEARING` transaction, no driver payable, no pharmacy payable, no
 * settlement, no payout, no provider call, no `Payment` row, no wallet, and no `settlementRef` —
 * §15 and §16 keep every one of those on Module 07's side. This command's entire output is a
 * reconciliation row, an audit entry, a status advance and one event.
 *
 * ## Idempotency and concurrency
 *
 * `cod_reconciliations.collectionId` is unique and the status advance is a compare-and-set on
 * `REMITTED`, so two finance officers reconciling at once converge on one authoritative row and the
 * loser is handed the winner's result rather than creating a second finding (§13). A replay cannot
 * move a collection backward out of `RECONCILED` (§12), because the compare-and-set no longer
 * matches and the unique index no longer admits a row.
 */
@Injectable()
export class ReconcileCodCollectionCommand {
  constructor(
    @Inject(COD_COLLECTION_REPOSITORY) private readonly collections: ICodCollectionRepository,
    @Inject(UNIT_OF_WORK) private readonly uow: IUnitOfWork,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  async execute(input: ReconcileCodCollectionInput): Promise<ReconcileCodCollectionResult> {
    const actorUserId = requireText(input.actorUserId, 'actorUserId');
    const collectionId = requireText(input.collectionId, 'collectionId');
    const reference = requireOptional(input.reference, 'reference', MAX_REMITTANCE_REFERENCE_LENGTH);
    const note = requireOptional(input.note, 'note', MAX_REMITTANCE_NOTE_LENGTH);

    const collection = await this.collections.findById(collectionId);
    if (!collection) {
      throw DeliveryErrors.codCollectionNotFound(collectionId);
    }

    const remittance = await this.collections.findRemittanceByCollectionId(collectionId);
    if (!remittance) {
      // There is nothing to check. A collection with no remittance has not been handed over, so a
      // reconciliation of it could only ever be a statement about money nobody has received.
      throw DeliveryErrors.codReconciliationNotAllowed(collectionId, collection.status);
    }

    // The cheap replay: one indexed read, nothing written, no event.
    const existing = await this.collections.findReconciliationByCollectionId(collectionId);
    if (existing) {
      return this.resolveExisting(collection, remittance, existing, { reference, note });
    }

    if (!CodCollectionPolicy.isReconciliationAllowedIn(collection.status)) {
      throw DeliveryErrors.codReconciliationNotAllowed(collectionId, collection.status);
    }

    // Derived here and passed in, so the entity can never be constructed with an outcome nobody
    // computed. There is no path by which an operator can mark a shortfall `ACCEPTED`.
    const outcome = CodCollectionPolicy.classifyReconciliation(collection, remittance);

    const reconciliation = CodReconciliation.record({
      id: randomUUID(),
      collectionId: collection.id,
      outcome,
      reference,
      note,
      reconciledByUserId: actorUserId,
    }).toProps();

    const written = await runWithDeliveryRetry(this.uow, async (tx) => {
      const inserted = await this.collections.insertReconciliation(reconciliation, tx);
      if (!inserted) {
        // Somebody won the unique index; the transaction is aborted. Recovery happens below, on a
        // fresh connection, after this one has unwound.
        return null;
      }

      const advanced = await this.collections.advanceToReconciled(
        collection.id,
        inserted.reconciledAt,
        tx,
      );
      if (!advanced) {
        // Rolling back is the only safe answer: a committed reconciliation attached to a collection
        // whose status denies it would be a finding nothing points at.
        const current = await this.collections.findById(collection.id, tx);
        throw DeliveryErrors.codReconciliationNotAllowed(
          collection.id,
          current?.status ?? collection.status,
        );
      }

      await this.audit.record(
        {
          actorUserId,
          action: 'DELIVERY_COD_RECONCILED',
          resourceType: 'CodCollection',
          resourceId: collection.id,
          context: {
            reconciliationId: inserted.id,
            remittanceId: remittance.id,
            jobId: collection.jobId,
            orderId: collection.orderId,
            fulfillmentId: collection.fulfillmentId,
            driverId: collection.driverId,
            // All three figures and both gaps. §20 asks for "result/discrepancy", and a finding
            // recorded without the numbers it was reached from is a conclusion nobody can re-check.
            expectedAmount: collection.expectedAmount,
            collectedAmount: collection.collectedAmount,
            remittedAmount: remittance.remittedAmount,
            collectionVariance: varianceOf(collection),
            remittanceVariance: remittance.remittedAmount - collection.collectedAmount,
            outcome: inserted.outcome,
            currency: collection.currency,
            method: collection.method,
            remittanceReference: remittance.reference,
            reconciliationReference: inserted.reference,
            note: inserted.note,
            status: 'RECONCILED',
          },
        },
        tx,
      );

      await this.outbox.write(
        codReconciledEvent({
          reconciliationId: inserted.id,
          collectionId: collection.id,
          jobId: collection.jobId,
          orderId: collection.orderId,
          fulfillmentId: collection.fulfillmentId,
          driverId: collection.driverId,
          expectedAmount: collection.expectedAmount,
          collectedAmount: collection.collectedAmount,
          remittedAmount: remittance.remittedAmount,
          currency: collection.currency,
          method: collection.method,
          providerReference: collection.providerReference,
          remittanceReference: remittance.reference,
          reconciliationReference: inserted.reference,
          outcome: inserted.outcome,
          reconciledByUserId: inserted.reconciledByUserId,
          reconciledAt: inserted.reconciledAt.toISOString(),
        }),
        tx as OutboxCapableClient,
      );

      return inserted;
    });

    if (written === null) {
      const winner = await this.collections.findReconciliationByCollectionId(collectionId);
      if (!winner) {
        throw DeliveryErrors.codReconciliationAlreadyRecorded(collectionId);
      }
      const current = (await this.collections.findById(collectionId)) ?? collection;
      return this.resolveExisting(current, remittance, winner, { reference, note });
    }

    return this.toResult(
      (await this.collections.findById(collectionId)) ?? collection,
      remittance,
      written,
      true,
    );
  }

  /**
   * Decides what a reconciliation request against an already-reconciled collection means.
   *
   * The comparison is on the two things the operator supplied — reference and note. The outcome is
   * deliberately not compared: it is computed from immutable rows, so it cannot have changed, and a
   * caller could not have submitted a different one in any case.
   *
   * A match replays the committed finding. A mismatch is a request to restate it, which §8 rules
   * out — reconciliation history is neither overwritten nor deleted.
   */
  private resolveExisting(
    collection: CodCollectionProps,
    remittance: CodRemittanceProps,
    stored: CodReconciliationProps,
    submitted: { reference: string | null; note: string | null },
  ): ReconcileCodCollectionResult {
    const same = stored.reference === submitted.reference && stored.note === submitted.note;
    if (!same) {
      throw DeliveryErrors.codReconciliationAlreadyRecorded(collection.id);
    }
    return this.toResult(collection, remittance, stored, false);
  }

  private toResult(
    collection: CodCollectionProps,
    remittance: CodRemittanceProps,
    reconciliation: CodReconciliationProps,
    created: boolean,
  ): ReconcileCodCollectionResult {
    return {
      collection,
      remittance,
      reconciliation,
      collectionVariance: varianceOf(collection),
      remittanceVariance: remittance.remittedAmount - collection.collectedAmount,
      created,
    };
  }
}

/** Whether a stored finding says every amount agreed. Re-exported for readers of this command. */
export function isAccepted(reconciliation: CodReconciliationProps): boolean {
  return reconciliation.outcome === CodReconciliationOutcome.ACCEPTED;
}

function requireOptional(
  value: string | null | undefined,
  field: string,
  max: number,
): string | null {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text.length === 0) {
    return null;
  }
  if (text.length > max) {
    throw DeliveryErrors.validation(`${field} must be at most ${max} characters.`, { field });
  }
  return text;
}

function requireText(value: string, field: string): string {
  const text = (value ?? '').trim();
  if (!text) {
    throw DeliveryErrors.validation(`${field} is required.`, { field });
  }
  return text;
}
