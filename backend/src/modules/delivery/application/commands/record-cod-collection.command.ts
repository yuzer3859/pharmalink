import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { AuditService } from '../../../../shared/audit/audit.service';
import { CONFIG_PORT, IConfigPort } from '../../../../shared/config/config.port';
import { OutboxCapableClient, OutboxService } from '../../../../shared/outbox/outbox.service';
import {
  CodCollection,
  CodCollectionProps,
  hasDiscrepancy,
  varianceOf,
} from '../../domain/entities/cod-collection.entity';
import { CodCollectionMethod } from '../../domain/enums';
import { codCollectedEvent } from '../../domain/events';
import { DeliveryErrors } from '../../domain/errors';
import {
  COD_COLLECTION_REPOSITORY,
  ICodCollectionRepository,
} from '../../domain/repositories/cod-collection.repository';
import {
  DELIVERY_JOB_REPOSITORY,
  IDeliveryJobRepository,
} from '../../domain/repositories/delivery-job.repository';
import {
  DRIVER_PROFILE_REPOSITORY,
  IDriverProfileRepository,
} from '../../domain/repositories/driver-profile.repository';
import { CodCollectionPolicy } from '../../domain/services/cod-collection-policy';
import { IIdentityPort, IDENTITY_PORT } from '../ports/outbound/identity.port';
import { IUnitOfWork, UNIT_OF_WORK } from '../ports/unit-of-work.port';
import { resolveCodSettings } from '../services/cod-settings';
import { runWithDeliveryRetry } from '../support/delivery-retry';

export interface RecordCodCollectionInput {
  /** Module 01 `users.id`, from the access token. **Never** a client-supplied driver id. */
  userId: string;
  jobId: string;
  /** What the driver declares they received, in minor units. */
  collectedAmount: number;
  method: CodCollectionMethod;
  /** An opaque transaction reference for an electronic collection. Never a provider payload. */
  providerReference?: string | null;
  /** When the money changed hands, if the handset queued the submission offline. */
  collectedAt?: Date | null;
}

export interface RecordCodCollectionResult {
  collection: CodCollectionProps;
  /** `false` when this submission matched a collection already recorded — an idempotent retry. */
  created: boolean;
}

/**
 * `RecordCod` (§3.5 F-COD-01, §6's `CompleteDelivery → if COD → RecordCod → CodCollection`,
 * BR-DEL-10) — records what a driver collected from a customer at the door.
 *
 * ## What the caller may say, and what it may not
 *
 * A driver supplies **three** things: how much they received, how, and — for an electronic
 * collection — a reference. Everything else is resolved here from the delivery job.
 *
 * In particular the **expected** amount is never accepted from a request and there is no field on
 * `RecordCodCollectionInput` through which it could arrive. It comes from
 * `delivery_jobs.codAmount`, frozen from `Order.grandTotal` when the job was cut (Work 02): a
 * collection channel does not get to say how much it was asked to collect. Nor does it supply a
 * driver id — that is resolved from the token, as it is on every other driver path in this module.
 *
 * ## Order of operations
 *
 * 1. **Authorize** — the caller must be the job's currently assigned driver, resolved from their
 *    token, and must still be an eligible driver in Module 01's eyes (BRULE-09, read live outside
 *    the transaction per ADR-014). A job that is somebody else's answers `NOT_FOUND`.
 * 2. **Check the delivery is COD at all** — a job with `isCod: false` has nothing to collect.
 * 3. **Check the stage** — `ARRIVED_DROPOFF` only, per `CodCollectionPolicy`, which is the same
 *    window proof of delivery uses and for the same reason: money and goods change hands at the
 *    door, and a collection recorded afterwards would be cash attached to a finished delivery at
 *    an unknown moment.
 * 4. **Check the amount** against whatever rule the operator has set — by default none, so a
 *    discrepancy is recorded rather than refused.
 * 5. **Short-circuit an existing collection** — read before anything is written, so the
 *    overwhelmingly common retry costs one indexed read.
 * 6. **Write the row, its audit entry and the `CodCollected` event**, together, in one
 *    `Serializable` transaction.
 *
 * ## Under- and overpayment
 *
 * Both are **recorded, not rejected**, under the shipped configuration. A driver holding less money
 * than the order came to has a real situation, and refusing the submission would leave no trace of
 * it — worse, it would push them towards typing the expected figure instead of the true one, which
 * turns a recorded shortfall into an unrecorded one.
 *
 * The row keeps both numbers, the discrepancy travels on the event, and
 * `CodCollectionPolicy.isReconcilable` refuses to treat the collection as settled cash. What the
 * platform *does* about a shortfall — recover from the driver, absorb it, chase the customer — is a
 * commercial and possibly disciplinary decision nobody has taken, and this command deliberately
 * does not take it on their behalf. An operator who decides COD must be exact sets
 * `delivery.codRequireExactAmount` and the refusal moves to step 4.
 *
 * What never happens is the one thing §7 names outright: no fake successful payment is created so
 * that a delivery can look complete.
 *
 * ## Idempotency is the database's, not a cache's
 *
 * `cod_collections.jobId` is unique. A handset at a doorstep on a bad connection retries, and two
 * API nodes can reach the insert simultaneously — neither of which application-level deduplication
 * can settle. A retry has three outcomes, decided by comparing what is stored against what arrived:
 *
 *  - **same declaration** — the first submission succeeded. Returns the stored collection with
 *    `created: false`: no second row, no second audit entry, and **no second `CodCollected`
 *    event**, which is what stops Module 07 being told twice that it is owed the same cash.
 *  - **different declaration** — a request to restate how much money changed hands, which §15
 *    forbids. Refused, because reporting success for a submission that was discarded would be a lie
 *    about what the record says.
 *  - **nothing stored** — the ordinary first recording.
 *
 * The unique-violation recovery re-reads on a **fresh connection, outside the transaction**: a
 * unique violation aborts the enclosing Postgres transaction, so recovering inside it fails on the
 * next statement — the defect the proof-of-delivery work found against a real database.
 *
 * ## What it does not do
 *
 * It does not deliver the order, does not complete the job, and does not move money. No ledger
 * entry, no `Payment` marked captured, no wallet, no settlement, no payout, and no `REMITTED` or
 * `RECONCILED` status — §1 gives every one of those to Module 07, which learns what it needs from
 * the `CodCollected` event written in this same transaction.
 */
@Injectable()
export class RecordCodCollectionCommand {
  constructor(
    @Inject(DELIVERY_JOB_REPOSITORY) private readonly jobs: IDeliveryJobRepository,
    @Inject(DRIVER_PROFILE_REPOSITORY) private readonly profiles: IDriverProfileRepository,
    @Inject(COD_COLLECTION_REPOSITORY) private readonly collections: ICodCollectionRepository,
    @Inject(IDENTITY_PORT) private readonly identity: IIdentityPort,
    @Inject(CONFIG_PORT) private readonly config: IConfigPort,
    @Inject(UNIT_OF_WORK) private readonly uow: IUnitOfWork,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  async execute(input: RecordCodCollectionInput): Promise<RecordCodCollectionResult> {
    const userId = requireText(input.userId, 'userId');
    const jobId = requireText(input.jobId, 'jobId');
    const collectedAmount = requireAmount(input.collectedAmount);
    const method = requireMethod(input.method);
    const providerReference = this.normalizeReference(method, input.providerReference);

    const profile = await this.profiles.findByUserId(userId);
    if (!profile) {
      throw DeliveryErrors.driverProfileNotFound({ userId });
    }

    // BRULE-09, read live and outside the transaction (ADR-014). A driver whose approval was
    // revoked must not be able to record taking a customer's money on the platform's behalf.
    const identity = await this.identity.getDriverIdentity(userId);
    if (!identity.isEligible) {
      throw DeliveryErrors.driverNotVerified(userId, identity.reason ?? 'UNKNOWN');
    }

    const job = await this.jobs.findById(jobId);
    if (!job || job.assignedDriverId !== profile.id) {
      // Not `FORBIDDEN`: a driver must not be able to tell "that delivery is somebody else's" from
      // "there is no such delivery", which would make job ids probeable for who is carrying what.
      throw DeliveryErrors.notFound('Delivery job not found.', { jobId });
    }
    if (!job.isCod) {
      throw DeliveryErrors.codNotApplicable(jobId);
    }
    if (!CodCollectionPolicy.isRecordingAllowedIn(job.status)) {
      throw DeliveryErrors.codCollectionNotAcceptable(jobId, job.status);
    }

    const expectedAmount = job.codAmount ?? 0;
    const settings = resolveCodSettings(this.config);
    if (!CodCollectionPolicy.isAmountAcceptable(expectedAmount, collectedAmount, settings)) {
      throw DeliveryErrors.codAmountMismatch(jobId, expectedAmount, collectedAmount);
    }

    // The cheap retry: one indexed read, nothing written, no event.
    const existing = await this.collections.findByJobId(jobId);
    if (existing) {
      return this.resolveExisting(existing, {
        collectedAmount,
        method,
        providerReference,
      });
    }

    const collection = CodCollection.record({
      id: randomUUID(),
      jobId: job.id,
      orderId: job.orderId,
      fulfillmentId: job.fulfillmentId,
      driverId: profile.id,
      // Authoritative, from the job. Not from the request — there is no field for it.
      expectedAmount,
      collectedAmount,
      currency: 'ETB',
      method,
      providerReference,
      collectedAt: input.collectedAt ?? null,
    }).toProps();

    const written = await runWithDeliveryRetry(this.uow, async (tx) => {
      const inserted = await this.collections.insert(collection, tx);
      if (!inserted) {
        // Somebody won the unique index. The transaction is now aborted, so the recovery cannot
        // happen here — it happens below, on a fresh connection, after this one has unwound.
        return null;
      }

      await this.audit.record(
        {
          actorUserId: userId,
          action: 'DELIVERY_COD_COLLECTED',
          resourceType: 'CodCollection',
          resourceId: inserted.id,
          context: {
            jobId: inserted.jobId,
            orderId: inserted.orderId,
            fulfillmentId: inserted.fulfillmentId,
            driverId: inserted.driverId,
            // Both figures and the signed difference, because the question a COD dispute asks is
            // not "how much" but "how much against how much" — and a shortfall that is only
            // derivable is a shortfall nobody searches for.
            expectedAmount: inserted.expectedAmount,
            collectedAmount: inserted.collectedAmount,
            variance: varianceOf(inserted),
            currency: inserted.currency,
            method: inserted.method,
            // The reference is a transaction number a human quotes during reconciliation, not a
            // secret. No provider payload, no signature and no customer detail is recorded here.
            providerReference: inserted.providerReference,
            status: inserted.status,
          },
        },
        tx,
      );

      // The handoff to Module 07, in the same transaction as the row it describes (ADR-010). A
      // collection that existed without its event would be cash the financial layer never heard
      // about; an event without its collection would be a reconciliation instruction with no record.
      await this.outbox.write(
        codCollectedEvent({
          collectionId: inserted.id,
          jobId: inserted.jobId,
          orderId: inserted.orderId,
          fulfillmentId: inserted.fulfillmentId,
          driverId: inserted.driverId,
          expectedAmount: inserted.expectedAmount,
          collectedAmount: inserted.collectedAmount,
          currency: inserted.currency,
          method: inserted.method,
          providerReference: inserted.providerReference,
          collectedAt: inserted.collectedAt.toISOString(),
        }),
        tx as OutboxCapableClient,
      );

      return { collection: inserted, created: true };
    });

    if (written === null) {
      const winner = await this.collections.findByJobId(jobId);
      if (!winner) {
        // The collision was real and the winner is gone — a rollback between the two. Nothing was
        // written by this call either, so reporting the refusal is honest and the caller retries.
        throw DeliveryErrors.codCollectionAlreadyRecorded(jobId);
      }
      return this.resolveExisting(winner, { collectedAmount, method, providerReference });
    }

    return written;
  }

  /**
   * Decides what a submission against an already-recorded collection means.
   *
   * The comparison is on the three things the driver declared — amount, method and reference. The
   * expected amount is deliberately not compared: it came from the job rather than the request, so
   * a difference there would mean the job changed underneath, which is not something the driver's
   * resubmission is asserting anything about.
   *
   * A match is the handset retrying and succeeds silently. A mismatch is a request to restate how
   * much cash changed hands, and is refused — §15's immutability. Keeping the first record and
   * reporting success would be worse than refusing: the driver would believe their correction had
   * been accepted.
   */
  private resolveExisting(
    stored: CodCollectionProps,
    submitted: {
      collectedAmount: number;
      method: CodCollectionMethod;
      providerReference: string | null;
    },
  ): RecordCodCollectionResult {
    const same =
      stored.collectedAmount === submitted.collectedAmount &&
      stored.method === submitted.method &&
      stored.providerReference === submitted.providerReference;

    if (!same) {
      throw DeliveryErrors.codCollectionAlreadyRecorded(stored.jobId);
    }
    return { collection: stored, created: false };
  }

  /**
   * Trims a reference, and refuses one on a cash collection.
   *
   * Cash has no provider and therefore no transaction number; a reference on a cash row would be a
   * string nobody could reconcile against anything. Refused at the boundary rather than dropped,
   * because silently discarding a field a driver filled in is how a genuine electronic collection
   * gets recorded as untraceable cash.
   */
  private normalizeReference(
    method: CodCollectionMethod,
    reference?: string | null,
  ): string | null {
    const text = typeof reference === 'string' ? reference.trim() : '';
    if (text.length === 0) {
      return null;
    }
    if (method === CodCollectionMethod.CASH) {
      throw DeliveryErrors.validation('A cash collection cannot carry a provider reference.', {
        field: 'providerReference',
        method,
      });
    }
    return text;
  }
}

/** Whether a stored collection's amounts disagree. Re-exported for readers of this command. */
export { hasDiscrepancy };

function requireAmount(value: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw DeliveryErrors.validation(
      'collectedAmount must be a non-negative integer (minor units).',
      { field: 'collectedAmount', value },
    );
  }
  return value;
}

function requireMethod(method: CodCollectionMethod): CodCollectionMethod {
  if (!Object.values(CodCollectionMethod).includes(method)) {
    throw DeliveryErrors.validation('method must be CASH or ELECTRONIC.', {
      field: 'method',
      value: method,
    });
  }
  return method;
}

function requireText(value: string, field: string): string {
  const text = (value ?? '').trim();
  if (!text) {
    throw DeliveryErrors.validation(`${field} is required.`, { field });
  }
  return text;
}
