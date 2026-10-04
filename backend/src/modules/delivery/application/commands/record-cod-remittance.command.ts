import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { AuditService } from '../../../../shared/audit/audit.service';
import { OutboxCapableClient, OutboxService } from '../../../../shared/outbox/outbox.service';
import { CodCollectionProps } from '../../domain/entities/cod-collection.entity';
import {
  CodRemittance,
  CodRemittanceProps,
  MAX_REMITTANCE_NOTE_LENGTH,
  MAX_REMITTANCE_REFERENCE_LENGTH,
} from '../../domain/entities/cod-remittance.entity';
import { codRemittedEvent } from '../../domain/events';
import { DeliveryErrors } from '../../domain/errors';
import {
  COD_COLLECTION_REPOSITORY,
  ICodCollectionRepository,
} from '../../domain/repositories/cod-collection.repository';
import {
  CodCollectionPolicy,
  CodRemittanceOutcome,
} from '../../domain/services/cod-collection-policy';
import { IUnitOfWork, UNIT_OF_WORK } from '../ports/unit-of-work.port';
import { runWithDeliveryRetry } from '../support/delivery-retry';

export interface RecordCodRemittanceInput {
  /** Module 01 `users.id` of the PharmaLink operator, from the access token. */
  actorUserId: string;
  /** `cod_collections.id` — the finance surface addresses collections, not delivery jobs. */
  collectionId: string;
  /** What actually reached PharmaLink, in minor units. Never defaulted from the collection. */
  remittedAmount: number;
  /** The generic PharmaLink-side handle for this handover. Shared across a batch. */
  reference: string;
  /** Three-letter ISO-4217. Defaults to the collection's own currency when omitted. */
  currency?: string | null;
  note?: string | null;
  /** When the money changed hands, if it is being keyed in later. */
  remittedAt?: Date | null;
}

export interface RecordCodRemittanceResult {
  collection: CodCollectionProps;
  remittance: CodRemittanceProps;
  /** How what arrived compares with what the driver declared taking. */
  outcome: CodRemittanceOutcome;
  /** `remittedAmount − collectedAmount`. Negative is a shortfall. */
  variance: number;
  /** `false` when this call matched a remittance already recorded — an idempotent replay. */
  created: boolean;
}

/**
 * `RecordCodRemittance` (§3.5 F-COD-01, §1, the design's Open Question 5) — an authorized
 * PharmaLink operator confirming that the driver or delivery partner handed the collected money
 * over.
 *
 * ## The second leg, and the separation of duties that defines it
 *
 * The money travels **customer → driver → PharmaLink → pharmacy**. The COD work recorded the first
 * leg on the driver's own word. This records the second — and crucially, **not** on the driver's
 * word. The actor here is a PharmaLink operator holding `finance:settlement:any`, a permission no
 * driver role holds and which is granted to nobody who can record a collection. A channel cannot
 * certify that it handed over the cash it is carrying; somebody on the receiving side has to say so.
 *
 * That is why this command takes `actorUserId` and never a driver id, why there is no
 * `driver_profiles` lookup anywhere in it, and why the route that reaches it lives under
 * `/admin/delivery/...` rather than beside the driver's `/delivery/jobs/{id}/cod-collection`.
 *
 * ## What it asserts, and the four things it does not
 *
 * The money reached PharmaLink. It does **not** mean the amounts were checked (that is
 * `ReconcileCodCollectionCommand`), does not mean the pharmacy has been paid, does not mean a
 * provider verified anything, and creates no financial obligation anywhere — §15 leaves every
 * ledger entry, payable, settlement and payout on Module 07's side, and this command writes none.
 *
 * ## The amount is recorded, never assumed
 *
 * `remittedAmount` is required and is never defaulted to `collection.collectedAmount`. A channel
 * that hands over less than it declared is the exact case a remittance step exists to catch, and a
 * command that filled the figure in from the collection would make that case unrepresentable: the
 * books would balance by construction, and the difference would surface — if ever — by somebody
 * counting cash.
 *
 * So all three outcomes are deterministic and none of them is a refusal:
 *
 *  - **exact** — the remittance matches the declaration.
 *  - **short** — less arrived than was declared. Recorded, with the gap on the audit entry and on
 *    the event.
 *  - **over** — more arrived. Recorded identically, because "more money than expected turned up" is
 *    just as much something finance needs to see as its opposite.
 *
 * A discrepancy never blocks the remittance and never marks it reconciled. §4's "a discrepancy must
 * remain visible" and "do not mark the collection `RECONCILED` merely because a remittance was
 * recorded" are the same instruction from two directions, and both are honoured by keeping the two
 * steps two commands.
 *
 * What the platform then *does* about a shortfall — recover it from the driver, absorb it, chase
 * the customer — is undecided everywhere in this repository, and this command deliberately does not
 * decide it on anybody's behalf.
 *
 * ## Order of operations
 *
 * 1. **Validate** the figures and the reference. No cross-module read is needed at all: a
 *    remittance is entirely between the platform and its own collection record.
 * 2. **Find the collection** — absent means there is nothing to remit (§1's "remittance requires an
 *    existing collection"), and the same answer covers "cannot remit before collection", because a
 *    collection row is what recording a collection creates.
 * 3. **Short-circuit an existing remittance** — read before anything is written, so a replay costs
 *    one indexed read.
 * 4. **Check the stage** — `COLLECTED` only.
 * 5. **Write the remittance, advance the collection, audit it and emit `CodRemitted`**, together,
 *    in one `Serializable` transaction.
 *
 * ## Idempotency is the database's
 *
 * `cod_remittances.collectionId` is unique. Two finance officers clicking at once on two API nodes
 * is not something application-level deduplication can settle, and neither is a console retrying a
 * request whose response was lost. A repeat has three outcomes, decided by comparing what is stored
 * against what arrived:
 *
 *  - **same confirmation** — returns the stored remittance with `created: false`: no second row, no
 *    second audit entry, and no second `CodRemitted` event telling a future Module 07 that the same
 *    cash arrived twice.
 *  - **different confirmation** — a request to overwrite what the platform recorded receiving,
 *    which §8 forbids. Refused, because reporting success for a figure that was discarded would
 *    leave an operator believing their correction had landed.
 *  - **nothing stored** — the ordinary first confirmation.
 *
 * The collision recovery re-reads on a **fresh connection, outside the transaction**: a unique
 * violation aborts the enclosing Postgres transaction, so recovering inside it fails on the next
 * statement.
 */
@Injectable()
export class RecordCodRemittanceCommand {
  constructor(
    @Inject(COD_COLLECTION_REPOSITORY) private readonly collections: ICodCollectionRepository,
    @Inject(UNIT_OF_WORK) private readonly uow: IUnitOfWork,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  async execute(input: RecordCodRemittanceInput): Promise<RecordCodRemittanceResult> {
    const actorUserId = requireText(input.actorUserId, 'actorUserId');
    const collectionId = requireText(input.collectionId, 'collectionId');
    const remittedAmount = requireAmount(input.remittedAmount);
    const reference = requireReference(input.reference);
    const note = requireNote(input.note);

    const collection = await this.collections.findById(collectionId);
    if (!collection) {
      // Covers both "no such collection" and "this delivery's cash was never collected" — the
      // second is what "cannot remit before collection" looks like, because the collection row is
      // what recording a collection creates.
      throw DeliveryErrors.codCollectionNotFound(collectionId);
    }

    // The collection's own currency unless the caller names one, and then it must agree. A
    // remittance in a currency the collection was not taken in is not a smaller problem than a
    // wrong amount — this module holds no exchange rate and must not appear to.
    const currency = (input.currency ?? collection.currency).trim().toUpperCase();
    if (currency !== collection.currency) {
      throw DeliveryErrors.validation(
        'A remittance must be in the same currency as the collection it covers.',
        { field: 'currency', collectionCurrency: collection.currency, submitted: currency },
      );
    }

    const submitted = { remittedAmount, currency, reference, note };

    // The cheap replay: one indexed read, nothing written, no event.
    const existing = await this.collections.findRemittanceByCollectionId(collectionId);
    if (existing) {
      return this.resolveExisting(collection, existing, submitted);
    }

    if (!CodCollectionPolicy.isRemittanceAllowedIn(collection.status)) {
      throw DeliveryErrors.codRemittanceNotAllowed(collectionId, collection.status);
    }

    const remittance = CodRemittance.record({
      id: randomUUID(),
      collectionId: collection.id,
      remittedAmount,
      currency,
      reference,
      note,
      confirmedByUserId: actorUserId,
      remittedAt: input.remittedAt ?? null,
    }).toProps();

    const outcome = CodCollectionPolicy.classifyRemittance(
      collection.collectedAmount,
      remittedAmount,
    );

    const written = await runWithDeliveryRetry(this.uow, async (tx) => {
      const inserted = await this.collections.insertRemittance(remittance, tx);
      if (!inserted) {
        // Somebody won the unique index. The transaction is now aborted, so the recovery cannot
        // happen here — it happens below, on a fresh connection, after this one has unwound.
        return null;
      }

      // The projection the finance list scans. Compare-and-set, so a collection that moved between
      // the check above and this write is refused rather than overwritten.
      const advanced = await this.collections.advanceToRemitted(
        collection.id,
        inserted.remittedAt,
        tx,
      );
      if (!advanced) {
        // Practically unreachable at `Serializable` — the competing writer would have conflicted
        // first — but if it happens, rolling back is the only safe answer: committing here would
        // leave a remittance row attached to a collection whose status denies it.
        const current = await this.collections.findById(collection.id, tx);
        throw DeliveryErrors.codRemittanceNotAllowed(
          collection.id,
          current?.status ?? collection.status,
        );
      }

      await this.audit.record(
        {
          // The PharmaLink operator, never the driver. §20's "actor" for this step, and the only
          // durable record of *who on the receiving side* said the money arrived.
          actorUserId,
          action: 'DELIVERY_COD_REMITTED',
          resourceType: 'CodCollection',
          resourceId: collection.id,
          context: {
            remittanceId: inserted.id,
            jobId: collection.jobId,
            orderId: collection.orderId,
            fulfillmentId: collection.fulfillmentId,
            // The channel that handed it over — a `driver_profiles.id`, so the audit trail names
            // both sides of the handover without copying any Module 01 identity into it.
            driverId: collection.driverId,
            // All three figures, because the question a cash audit asks is "how much against how
            // much" — a shortfall that is only derivable is a shortfall nobody searches for.
            expectedAmount: collection.expectedAmount,
            collectedAmount: collection.collectedAmount,
            remittedAmount: inserted.remittedAmount,
            variance: inserted.remittedAmount - collection.collectedAmount,
            outcome,
            currency: inserted.currency,
            method: collection.method,
            // A deposit slip or cash-office batch label. Not a secret, and not a provider payload.
            reference: inserted.reference,
            note: inserted.note,
            status: 'REMITTED',
          },
        },
        tx,
      );

      await this.outbox.write(
        codRemittedEvent({
          remittanceId: inserted.id,
          collectionId: collection.id,
          jobId: collection.jobId,
          orderId: collection.orderId,
          fulfillmentId: collection.fulfillmentId,
          driverId: collection.driverId,
          expectedAmount: collection.expectedAmount,
          collectedAmount: collection.collectedAmount,
          remittedAmount: inserted.remittedAmount,
          currency: inserted.currency,
          method: collection.method,
          providerReference: collection.providerReference,
          reference: inserted.reference,
          confirmedByUserId: inserted.confirmedByUserId,
          remittedAt: inserted.remittedAt.toISOString(),
        }),
        tx as OutboxCapableClient,
      );

      return inserted;
    });

    if (written === null) {
      const winner = await this.collections.findRemittanceByCollectionId(collectionId);
      if (!winner) {
        // The collision was real and the winner is gone — a rollback between the two. Nothing was
        // written by this call either, so reporting the refusal is honest and the caller retries.
        throw DeliveryErrors.codRemittanceAlreadyRecorded(collectionId);
      }
      const current = (await this.collections.findById(collectionId)) ?? collection;
      return this.resolveExisting(current, winner, submitted);
    }

    return {
      // Re-read rather than assumed: the caller is told the status the database now holds, not the
      // one this command intended to write.
      collection: (await this.collections.findById(collectionId)) ?? collection,
      remittance: written,
      outcome,
      variance: written.remittedAmount - collection.collectedAmount,
      created: true,
    };
  }

  /**
   * Decides what a confirmation against an already-remitted collection means.
   *
   * The comparison is on the four things the operator asserted — amount, currency, reference and
   * note. `remittedAt` is deliberately excluded, for the same reason `RecordCodCollectionCommand`
   * excludes `collectedAt`: it defaults to now when omitted, so comparing it would turn every
   * ordinary replay into a false mismatch.
   *
   * A match is a console retrying and succeeds silently. A mismatch is a request to restate how
   * much money PharmaLink received, and is refused — §8's immutability. Keeping the first and
   * reporting success would be worse than refusing: the operator would believe their correction had
   * been accepted.
   */
  private resolveExisting(
    collection: CodCollectionProps,
    stored: CodRemittanceProps,
    submitted: {
      remittedAmount: number;
      currency: string;
      reference: string;
      note: string | null;
    },
  ): RecordCodRemittanceResult {
    const same =
      stored.remittedAmount === submitted.remittedAmount &&
      stored.currency === submitted.currency &&
      stored.reference === submitted.reference &&
      stored.note === submitted.note;

    if (!same) {
      throw DeliveryErrors.codRemittanceAlreadyRecorded(collection.id);
    }

    return {
      collection,
      remittance: stored,
      outcome: CodCollectionPolicy.classifyRemittance(
        collection.collectedAmount,
        stored.remittedAmount,
      ),
      variance: stored.remittedAmount - collection.collectedAmount,
      created: false,
    };
  }
}

function requireAmount(value: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw DeliveryErrors.validation(
      'remittedAmount must be a non-negative integer (minor units).',
      { field: 'remittedAmount', value },
    );
  }
  return value;
}

function requireReference(value: string): string {
  const text = (value ?? '').trim();
  if (!text) {
    // Required, unlike a collection's `providerReference`. Cash can honestly have no reference;
    // a remittance is an act PharmaLink performed and can always name, and without a handle §19's
    // "group a day's cash by handover" has nothing to group on.
    throw DeliveryErrors.validation('reference is required.', { field: 'reference' });
  }
  if (text.length > MAX_REMITTANCE_REFERENCE_LENGTH) {
    throw DeliveryErrors.validation(
      `reference must be at most ${MAX_REMITTANCE_REFERENCE_LENGTH} characters.`,
      { field: 'reference' },
    );
  }
  return text;
}

function requireNote(value?: string | null): string | null {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text.length === 0) {
    return null;
  }
  if (text.length > MAX_REMITTANCE_NOTE_LENGTH) {
    throw DeliveryErrors.validation(
      `note must be at most ${MAX_REMITTANCE_NOTE_LENGTH} characters.`,
      { field: 'note' },
    );
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
