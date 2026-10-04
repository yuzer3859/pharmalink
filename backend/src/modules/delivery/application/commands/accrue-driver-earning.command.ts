import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { AuditService } from '../../../../shared/audit/audit.service';
import { CONFIG_PORT, IConfigPort } from '../../../../shared/config/config.port';
import { OutboxCapableClient, OutboxService } from '../../../../shared/outbox/outbox.service';
import { DeliveryJobProps } from '../../domain/entities/delivery-job.entity';
import {
  DriverEarning,
  DriverEarningProps,
} from '../../domain/entities/driver-earning.entity';
import { DeliveryJobStatus } from '../../domain/enums';
import { earningAccruedEvent } from '../../domain/events';
import { DeliveryErrors } from '../../domain/errors';
import {
  DELIVERY_JOB_REPOSITORY,
  IDeliveryJobRepository,
} from '../../domain/repositories/delivery-job.repository';
import {
  DRIVER_EARNING_REPOSITORY,
  IDriverEarningRepository,
} from '../../domain/repositories/driver-earning.repository';
import { DriverEarningPolicy } from '../../domain/services/driver-earning-policy';
import { IUnitOfWork, UNIT_OF_WORK } from '../ports/unit-of-work.port';
import { resolveDriverEarningSettings } from '../services/driver-earning-settings';
import { runWithDeliveryRetry } from '../support/delivery-retry';

export interface AccrueDriverEarningInput {
  /** The delivered job. Everything else is resolved from it — nothing else is accepted. */
  jobId: string;
  /** Who or what triggered accrual, for the trail. `null` for the event-driven path. */
  actorUserId?: string | null;
}

export interface AccrueDriverEarningResult {
  earning: DriverEarningProps;
  /** `false` when an already-accrued earning was returned rather than a new one written. */
  created: boolean;
}

/**
 * The statuses from which an earning may be accrued.
 *
 * `DELIVERED` is the ordinary one — the handover has happened and the driver has done the work.
 * `COMPLETED` is included for a specific recovery case rather than for symmetry: if a future path
 * ever completes a job by some route that skipped accrual, an operator must still be able to pay
 * the driver. Accruing from a completed job writes the same row it would have written a moment
 * earlier, and the unique index means it can only ever happen once.
 *
 * Everything before `DELIVERED` is refused. A driver who is still riding has not earned a delivery
 * fee, and an earning accrued mid-route would be a liability recorded for work that might yet fail.
 */
const ACCRUABLE_STATUSES: readonly DeliveryJobStatus[] = [
  DeliveryJobStatus.DELIVERED,
  DeliveryJobStatus.COMPLETED,
];

/**
 * `AccrueEarning` (§3.5 F-ERN-01, §6's `CompleteDelivery → AccrueEarning (idempotent) →
 * DriverEarning(ACCRUED)`, BR-DEL-10, §11's `AccrueEarning`) — records what a driver is owed for a
 * delivery they have made.
 *
 * ## The input is one job id, deliberately
 *
 * Not an amount, not a driver, not a distance, not a rate. Every fact the earning is built from is
 * resolved here from the delivery job, because a caller that could supply an amount could supply
 * the wrong one — and this is not a price a customer can dispute at the till, it is a payment
 * obligation to a person that nobody may be looking at.
 *
 * There is no HTTP route that reaches this command at all. The only caller is
 * `DeliveryCompletionHandler`, driven by the `OrderDelivered` event; the only other way in is an
 * operator running it deliberately. §14's "do NOT expose a route allowing clients to set earning
 * amounts" is satisfied by there being no route that sets anything.
 *
 * ## What it computes from, and what it refuses to
 *
 * The **frozen** facts Work 09 recorded on the job: `distanceMeters`, the route the job was
 * dispatched against, and `deliveryFee`, the amount Module 06 actually charged. Neither is
 * re-derived. The driver's current position is never consulted, no fresh route is measured, and
 * today's delivery rate card is never read — an earning accrued a week after a delivery must be
 * the earning that delivery generated, not the one it would generate now.
 *
 * When the agreement charges by the kilometre and the job has no distance, this **refuses** with a
 * retriable `BUSINESS_RULE_VIOLATION` (§10). The job keeps its `DELIVERED` status, nothing is
 * written, and nothing is invented to fill the gap. That refusal is visible and recoverable, which
 * is the whole design: a silent zero would underpay somebody, and a freshly-measured distance
 * would pay them for a journey computed between places they are no longer at.
 *
 * ## Idempotency is the database's
 *
 * `driver_earnings.jobId` carries a unique index. The outbox is at-least-once by design (ADR-010),
 * so the completion that triggers accrual **will** sometimes arrive twice, and two API nodes can
 * reach the insert at the same instant — neither of which application-level deduplication can
 * settle. Postgres settles both, and the loser returns the winner's row with `created: false`.
 *
 * The re-read after a collision happens on a **fresh connection, outside the transaction**. A
 * unique violation puts a Postgres transaction into an aborted state, so recovering inside it
 * fails on the next statement — a real defect the proof-of-delivery work found against a real
 * database, and the reason `insert` returns `null` rather than throwing.
 *
 * ## What it does not do
 *
 * It does not pay anybody. No ledger entry, no wallet movement, no settlement, no payout, no
 * provider call, and no `SETTLED` status — §1 gives money movement to Module 07, which learns what
 * it owes from the `EarningAccrued` event written in this same transaction. It also does not
 * complete the job: `AdvanceDeliveryJobCommand` does that, and requires this to have happened first.
 */
@Injectable()
export class AccrueDriverEarningCommand {
  constructor(
    @Inject(DELIVERY_JOB_REPOSITORY) private readonly jobs: IDeliveryJobRepository,
    @Inject(DRIVER_EARNING_REPOSITORY) private readonly earnings: IDriverEarningRepository,
    @Inject(CONFIG_PORT) private readonly config: IConfigPort,
    @Inject(UNIT_OF_WORK) private readonly uow: IUnitOfWork,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  async execute(input: AccrueDriverEarningInput): Promise<AccrueDriverEarningResult> {
    const jobId = requireText(input.jobId, 'jobId');

    // Cheap replay: a redelivered event computes nothing and reads no configuration.
    const existing = await this.earnings.findByJobId(jobId);
    if (existing) {
      return { earning: existing, created: false };
    }

    const job = await this.jobs.findById(jobId);
    if (!job) {
      throw DeliveryErrors.notFound('Delivery job not found.', { jobId });
    }
    const earning = this.build(job);

    const written = await runWithDeliveryRetry(this.uow, async (tx) => {
      // Re-checked inside the transaction: a concurrent accrual may have committed since the read
      // above, and the insert below would otherwise be the first thing to notice.
      const raced = await this.earnings.findByJobId(jobId, tx);
      if (raced) {
        return { earning: raced, created: false };
      }

      const inserted = await this.earnings.insert(earning, tx);
      if (!inserted) {
        // Somebody won the unique index between the re-check and the insert. The transaction is
        // now aborted, so the recovery cannot happen here — it happens below, on a fresh
        // connection, after this one has unwound.
        return null;
      }

      await this.audit.record(
        {
          actorUserId: input.actorUserId ?? null,
          action: 'DELIVERY_EARNING_ACCRUED',
          resourceType: 'DriverEarning',
          resourceId: inserted.id,
          context: {
            jobId: inserted.jobId,
            orderId: inserted.orderId,
            fulfillmentId: inserted.fulfillmentId,
            driverId: inserted.driverId,
            // The components as well as the total, because the question an earnings dispute asks
            // is not only "how much" but "on what basis" — and the configuration that produced
            // them will have moved on by the time anybody asks.
            base: inserted.base,
            distanceComponent: inserted.distanceComponent,
            feeShare: inserted.feeShare,
            incentive: inserted.incentive,
            total: inserted.total,
            currency: inserted.currency,
            distanceMeters: inserted.distanceMeters,
            calculationVersion: inserted.calculationVersion,
          },
        },
        tx,
      );

      // The handoff to Module 07, in the same transaction as the row it describes (ADR-010). An
      // earning that existed without its event would be money owed that nobody downstream knew
      // about; an event without its earning would be a payment instruction with no record.
      await this.outbox.write(
        earningAccruedEvent({
          earningId: inserted.id,
          driverId: inserted.driverId,
          jobId: inserted.jobId,
          orderId: inserted.orderId,
          fulfillmentId: inserted.fulfillmentId,
          amount: inserted.total,
          currency: inserted.currency,
          calculationVersion: inserted.calculationVersion,
        }),
        tx as OutboxCapableClient,
      );

      return { earning: inserted, created: true };
    });

    if (written === null) {
      const winner = await this.earnings.findByJobId(jobId);
      if (!winner) {
        // The collision was real and the winner is gone — a rollback between the two. Nothing was
        // written by this call either, so reporting the refusal is honest and the caller retries.
        throw DeliveryErrors.earningNotAccruable(jobId, job.status);
      }
      return { earning: winner, created: false };
    }

    return written;
  }

  /**
   * Builds the earning from the job's own frozen facts.
   *
   * Outside the transaction: it is pure computation over a snapshot already read, so a
   * serialization retry recomputing it is harmless, and holding a `Serializable` transaction across
   * it would buy nothing.
   */
  private build(job: DeliveryJobProps): DriverEarningProps {
    if (!ACCRUABLE_STATUSES.includes(job.status)) {
      throw DeliveryErrors.earningNotAccruable(job.id, job.status);
    }
    if (job.assignedDriverId === null) {
      // A delivered job always has a driver — `DeliveryStatusPolicy` cannot reach `DELIVERED`
      // without passing through `ASSIGNED`. Checked anyway, because the alternative to refusing is
      // writing an earning that nobody can be paid.
      throw DeliveryErrors.earningNotAccruable(job.id, job.status);
    }

    const settings = resolveDriverEarningSettings(this.config);

    if (DriverEarningPolicy.requiresDistance(settings) && job.distanceMeters === null) {
      // §10, refused before anything is built. Retriable: the job stays `DELIVERED`, and an
      // operator who backfills the distance or drops the per-kilometre rate can re-run this.
      throw DeliveryErrors.earningDistanceUnavailable(job.id, settings.calculationVersion);
    }

    const breakdown = DriverEarningPolicy.calculate(
      // The frozen pair, straight off the job. Work 09 recorded both at creation precisely so this
      // work would not have to reverse-engineer either.
      { distanceMeters: job.distanceMeters, deliveryFee: job.deliveryFee },
      settings,
    );

    return DriverEarning.accrue({
      id: randomUUID(),
      driverId: job.assignedDriverId,
      jobId: job.id,
      orderId: job.orderId,
      fulfillmentId: job.fulfillmentId,
      base: breakdown.base,
      distanceComponent: breakdown.distanceComponent,
      feeShare: breakdown.feeShare,
      incentive: breakdown.incentive,
      total: breakdown.total.amountMinor,
      currency: breakdown.total.currency,
      distanceMeters: breakdown.distanceMeters,
      calculationVersion: breakdown.calculationVersion,
    }).toProps();
  }
}

function requireText(value: string, field: string): string {
  const text = (value ?? '').trim();
  if (!text) {
    throw DeliveryErrors.validation(`${field} is required.`, { field });
  }
  return text;
}
