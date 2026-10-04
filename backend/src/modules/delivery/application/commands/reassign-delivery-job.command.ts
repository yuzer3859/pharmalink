import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../../../shared/audit/audit.service';
import { DeliveryJob, DeliveryJobProps } from '../../domain/entities/delivery-job.entity';
import { DeliveryActorType, DeliveryJobStatus } from '../../domain/enums';
import { DeliveryErrors } from '../../domain/errors';
import {
  DELIVERY_JOB_REPOSITORY,
  IDeliveryJobRepository,
} from '../../domain/repositories/delivery-job.repository';
import { DeliveryStatusPolicy } from '../../domain/services/delivery-status-policy';
import { IUnitOfWork, UNIT_OF_WORK } from '../ports/unit-of-work.port';
import { runWithDeliveryRetry } from '../support/delivery-retry';
import {
  DispatchDeliveryJobCommand,
  DispatchOutcome,
} from './dispatch-delivery-job.command';

export interface ReassignDeliveryJobInput {
  jobId: string;
  /** Why — a driver went offline, an operator intervened. Recorded on the transition (§13). */
  reason: string;
  /** The operator or system actor requesting it. `null` for an automated sweep. */
  actorUserId?: string | null;
  actorType?: DeliveryActorType;
}

export interface ReassignDeliveryJobResult {
  job: DeliveryJobProps;
  /** The driver the job was taken from. */
  previousDriverId: string | null;
  /** What the follow-on dispatch did. `NoCandidate` leaves the job in `REASSIGNING`. */
  redispatch: DispatchOutcome;
}

/**
 * `ReassignDeliveryJob` (§3.2 F-JOB-05, §11.5, BR-DEL-08, BRULE-19) — take a job off one driver
 * and dispatch it to another.
 *
 * ## Pre-pickup only, and the state machine is what says so
 *
 * `DeliveryStatusPolicy` admits `REASSIGNING` from `ASSIGNED` and `ARRIVED_PICKUP` and from
 * nowhere else, because F-JOB-05 reassigns "if assigned driver goes offline/unavailable **before
 * pickup**" and §11.5's flow is "driver offline / cancels **pre-pickup**". After `PICKED_UP` the
 * medicines are in a bag on a motorbike, and a second driver cannot take over without a physical
 * handover that the design does not define — reassigning at that point would produce a job whose
 * records say one driver is delivering goods another driver is holding.
 *
 * This command does not restate that rule. It calls `transitionTo`, which asks the policy, so
 * there is exactly one place the pre-pickup boundary is written down.
 *
 * ## The previous driver is released, not erased
 *
 * `DeliveryJob.transitionTo(REASSIGNING)` clears `assignedDriverId`, which is what frees the
 * driver's concurrent-job slot: BRULE-28's count is derived from jobs in
 * `ACTIVE_JOB_STATUSES`, and `REASSIGNING` is deliberately not one of them, so the release
 * happens by virtue of the counting rules rather than through a counter somebody has to remember
 * to decrement.
 *
 * What survives is the trail. The previous driver's `ACCEPTED` offer row is untouched — the
 * partial unique index covers only live offers precisely so that it can be — and the
 * `delivery_status_history` row records who the job was taken from and why. An operator asking
 * "who had this before?" gets an answer; nothing is rewritten to pretend the first assignment
 * never happened.
 *
 * ## Two transactions, and why that is the right shape
 *
 * The release commits first; the re-dispatch follows in its own transaction (ADR-014 — the
 * candidate search is cross-module I/O and must not run inside a `Serializable` transaction).
 * `REASSIGNING` exists as a durable state for exactly this reason: if the second step finds
 * nobody, the job rests in a state that says "this needs a driver" and that
 * `DispatchDeliveryJobCommand` can pick up again at any time. The alternative — one transaction
 * holding a cross-module read — would trade a recoverable pause for an unavailable one.
 */
@Injectable()
export class ReassignDeliveryJobCommand {
  constructor(
    @Inject(DELIVERY_JOB_REPOSITORY) private readonly jobs: IDeliveryJobRepository,
    @Inject(UNIT_OF_WORK) private readonly uow: IUnitOfWork,
    private readonly dispatch: DispatchDeliveryJobCommand,
    private readonly audit: AuditService,
  ) {}

  async execute(input: ReassignDeliveryJobInput): Promise<ReassignDeliveryJobResult> {
    const jobId = requireText(input.jobId, 'jobId');
    const reason = requireText(input.reason, 'reason');
    const actorType = input.actorType ?? DeliveryActorType.SYSTEM;
    const now = new Date();

    const job = await this.jobs.findById(jobId);
    if (!job) {
      throw DeliveryErrors.notFound('Delivery job not found.', { jobId });
    }
    // Asked before the transaction purely so the caller gets the clearer error; the authoritative
    // refusal is `transitionTo` below, which cannot be bypassed.
    if (!DeliveryStatusPolicy.isLegalTransition(job.status, DeliveryJobStatus.REASSIGNING)) {
      throw DeliveryErrors.invalidStateTransition(job.status, DeliveryJobStatus.REASSIGNING);
    }

    const previousDriverId = job.assignedDriverId;

    const released = await runWithDeliveryRetry(this.uow, async (tx) => {
      const current = await this.jobs.findById(jobId, tx);
      if (!current) {
        throw DeliveryErrors.notFound('Delivery job not found.', { jobId });
      }

      // The domain decides. A job that reached `PICKED_UP` between the read above and here is
      // refused right there, which is the case this re-read exists for.
      const next = DeliveryJob.rehydrate(current).transitionTo(DeliveryJobStatus.REASSIGNING, {
        now,
      });

      const written = await this.jobs.updateState(
        jobId,
        { status: current.status, assignedDriverId: current.assignedDriverId },
        { status: next.status, assignedDriverId: null },
        tx,
      );
      if (!written) {
        throw DeliveryErrors.jobAlreadyAssigned(jobId, current.status);
      }

      await this.jobs.appendStatusHistory(
        {
          jobId,
          fromStatus: current.status,
          toStatus: next.status,
          actorType,
          actorId: input.actorUserId ?? null,
          // The driver the job was taken from, in the trail rather than only in the audit log:
          // `delivery_status_history` is what a dispute over a late delivery is read from.
          reason: `${reason} (released driver ${current.assignedDriverId ?? 'none'})`,
        },
        tx,
      );

      await this.audit.record(
        {
          actorUserId: input.actorUserId ?? null,
          action: 'DELIVERY_JOB_REASSIGNING',
          resourceType: 'DeliveryJob',
          resourceId: jobId,
          context: {
            orderId: current.orderId,
            fromStatus: current.status,
            previousDriverId: current.assignedDriverId,
            reason,
            actorType,
          },
        },
        tx,
      );

      return written;
    });

    // §11.5's "DispatchJob (exclude prior driver)". The exclusion is explicit as well as implicit:
    // the released driver's earlier offer already puts them in the job's offer history, which
    // `DispatchDeliveryJobCommand` excludes — but a reassignment is precisely the case where
    // re-offering the job to the driver it was just taken from would be worst, so it is stated.
    const redispatch = await this.dispatch.execute({
      jobId,
      excludeDriverIds: previousDriverId ? [previousDriverId] : [],
      actorUserId: input.actorUserId ?? null,
    });

    return { job: redispatch.job ?? released, previousDriverId, redispatch: redispatch.outcome };
  }
}

function requireText(value: string, field: string): string {
  const text = (value ?? '').trim();
  if (!text) {
    throw DeliveryErrors.validation(`${field} is required.`, { field });
  }
  return text;
}
