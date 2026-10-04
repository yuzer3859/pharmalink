import { Injectable } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import { DeliveryJobProps } from '../../domain/entities/delivery-job.entity';
import { DeliveryActorType, DeliveryJobStatus } from '../../domain/enums';
import { DeliveryErrors } from '../../domain/errors';
import {
  DELIVERY_JOB_REPOSITORY,
  IDeliveryJobRepository,
} from '../../domain/repositories/delivery-job.repository';
import { DeliveryStatusPolicy } from '../../domain/services/delivery-status-policy';
import { AdvanceDeliveryJobCommand } from './advance-delivery-job.command';

export interface CancelDeliveryJobInput {
  jobId: string;
  reason: string;
  actorUserId?: string | null;
  actorType?: DeliveryActorType;
}

export interface CancelJobsForOrderInput {
  orderId: string;
  reason: string;
  actorUserId?: string | null;
}

export interface CancelJobsForOrderResult {
  cancelled: DeliveryJobProps[];
  /** Jobs the pickup boundary refused, with the status that refused them. */
  refused: { jobId: string; status: DeliveryJobStatus }[];
  /** Jobs already cancelled — an idempotent replay, not a refusal. */
  unchanged: DeliveryJobProps[];
}

/**
 * `CancelDeliveryJob` (§6's `CANCELLED` branch, §9.3's "order cancelled upstream").
 *
 * ## The pickup boundary is the whole of this command
 *
 * `DeliveryStatusPolicy` admits `CANCELLED` from `CREATED`, `OFFERED`, `ASSIGNED`,
 * `ARRIVED_PICKUP` and `REASSIGNING` — every state in which nobody is yet carrying the goods —
 * and from nowhere after `PICKED_UP`. That rule was written in the domain-foundation work and is
 * not restated here: this command calls `transitionTo` through `AdvanceDeliveryJobCommand` and
 * the policy refuses.
 *
 * The reason it refuses matters more than the mechanism. Once a driver physically holds the
 * medicines, "cancelled" is a status that contradicts the world — the items exist, they are in a
 * bag, and they have to end up somewhere. The path for that is `FAILED`, which carries a return
 * obligation that `CANCELLED` does not, and which Module 06 and Module 07 act on. Letting an
 * upstream cancellation quietly mark a picked-up job `CANCELLED` would lose a bag of medicines
 * from the system's account of itself.
 *
 * ## What it deliberately does not do
 *
 * It does not decide what happens to goods already in transit, does not initiate a refund, and
 * does not touch a Module 06 row. A job it cannot cancel is **reported, not forced**: the caller
 * gets the job and the status that refused it, and the return/refund policy is Module 06's and
 * Module 07's to write — §3.3 F-STS-05's "retry/return policy → Orders/refund hook", which is its
 * own later work.
 */
@Injectable()
export class CancelDeliveryJobCommand {
  constructor(
    @Inject(DELIVERY_JOB_REPOSITORY) private readonly jobs: IDeliveryJobRepository,
    private readonly advance: AdvanceDeliveryJobCommand,
  ) {}

  /** Cancels one job. Throws `INVALID_DELIVERY_STATE_TRANSITION` past the pickup boundary. */
  async execute(input: CancelDeliveryJobInput): Promise<DeliveryJobProps> {
    const result = await this.advance.bySystem({
      jobId: input.jobId,
      to: DeliveryJobStatus.CANCELLED,
      reason: input.reason,
      actorUserId: input.actorUserId ?? null,
      actorType: input.actorType ?? DeliveryActorType.SYSTEM,
    });
    return result.job;
  }

  /**
   * Cancels every job an order produced (Module 06's `OrderCancelled`, catalogued with 08 as a
   * consumer: "08 (cancel job)").
   *
   * **Every** job, because §5.3's job-per-fulfillment means a split order has one per pharmacy,
   * and cancelling only the first would leave the second pharmacy's driver on the road. A job past
   * the pickup boundary is collected in `refused` rather than thrown, so one driver who has
   * already collected cannot stop the other jobs from being cancelled — the alternative would
   * make the outcome depend on which pharmacy happened to be quicker.
   */
  async forOrder(input: CancelJobsForOrderInput): Promise<CancelJobsForOrderResult> {
    const orderId = requireText(input.orderId, 'orderId');
    const reason = requireText(input.reason, 'reason');

    const jobs = await this.jobs.findByOrderId(orderId);
    const result: CancelJobsForOrderResult = { cancelled: [], refused: [], unchanged: [] };

    for (const job of jobs) {
      if (job.status === DeliveryJobStatus.CANCELLED) {
        // A redelivered `order.cancelled` (the outbox is at-least-once, ADR-010). Idempotent.
        result.unchanged.push(job);
        continue;
      }
      // Asked before attempting, so a terminal or post-pickup job is reported rather than
      // producing an exception the caller has to catch per job.
      if (!DeliveryStatusPolicy.isCancellable(job.status)) {
        result.refused.push({ jobId: job.id, status: job.status });
        continue;
      }
      const { job: cancelled } = await this.advance.bySystem({
        jobId: job.id,
        to: DeliveryJobStatus.CANCELLED,
        reason,
        actorUserId: input.actorUserId ?? null,
        actorType: DeliveryActorType.SYSTEM,
      });
      result.cancelled.push(cancelled);
    }

    return result;
  }
}

function requireText(value: string, field: string): string {
  const text = (value ?? '').trim();
  if (!text) {
    throw DeliveryErrors.validation(`${field} is required.`, { field });
  }
  return text;
}
