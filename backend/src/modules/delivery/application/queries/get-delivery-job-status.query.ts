import { Inject, Injectable } from '@nestjs/common';
import { DeliveryActorType, DeliveryJobStatus } from '../../domain/enums';
import { DeliveryErrors } from '../../domain/errors';
import {
  DELIVERY_JOB_REPOSITORY,
  IDeliveryJobRepository,
} from '../../domain/repositories/delivery-job.repository';

/** One transition, as a reader sees it. */
export interface DeliveryTransitionView {
  from: DeliveryJobStatus | null;
  to: DeliveryJobStatus;
  at: Date;
  actorType: DeliveryActorType;
  reason: string | null;
}

/**
 * When each physical event happened (§3.3's lifecycle).
 *
 * **Derived from `delivery_status_history`, not stored on the job.** `pickedUpAt` and
 * `deliveredAt` are columns on `delivery_jobs` because Module 06's order sync and the delivery
 * SLA read them directly; the other four have no such reader, and giving them columns as well
 * would put the same fact in two places that can disagree. The history is the record — it is
 * append-only, it is written in the same transaction as the transition it describes, and it
 * cannot drift from it.
 *
 * A timestamp is `null` when the job has not reached that state. `failedAt` and `cancelledAt` are
 * here too, because "when did this stop" is the first question asked about a job that did.
 */
export interface DeliveryTimelineView {
  assignedAt: Date | null;
  arrivedPickupAt: Date | null;
  pickedUpAt: Date | null;
  enRouteAt: Date | null;
  arrivedDropoffAt: Date | null;
  deliveredAt: Date | null;
  completedAt: Date | null;
  failedAt: Date | null;
  cancelledAt: Date | null;
}

export interface DeliveryJobStatusView {
  jobId: string;
  orderId: string;
  fulfillmentId: string;
  status: DeliveryJobStatus;
  /** `driver_profiles.id`, or `null` before assignment and after a release. */
  driverId: string | null;
  timeline: DeliveryTimelineView;
  /** Every transition, oldest first. */
  history: DeliveryTransitionView[];
}

export interface GetDeliveryJobStatusInput {
  jobId: string;
  /**
   * When set, the job must currently be assigned to this `driver_profiles.id`.
   *
   * `undefined` is unrestricted — for an in-process caller that has already established its own
   * authority. It is never defaulted from a request.
   */
  requireDriverId?: string;
}

/**
 * `GetDeliveryJobStatus` (§9.4's "REST fallback for status") — a job's current state and how it
 * got there.
 *
 * The read side of `AdvanceDeliveryJobCommand`, and the reason the status workflow adds no
 * timestamp columns: this is where the intermediate physical timestamps come from.
 *
 * It deliberately returns **no location** and **no proof of delivery**. §9.4 pairs this route with
 * a last-known position, and that belongs to the tracking work, which owns both the Redis-backed
 * hot state and the authorization question of who may see where a driver is. A status read is not
 * the place to answer that quietly.
 */
@Injectable()
export class GetDeliveryJobStatusQuery {
  constructor(
    @Inject(DELIVERY_JOB_REPOSITORY) private readonly jobs: IDeliveryJobRepository,
  ) {}

  async execute(input: GetDeliveryJobStatusInput): Promise<DeliveryJobStatusView> {
    const job = await this.jobs.findById(requireText(input.jobId, 'jobId'));
    if (!job) {
      throw DeliveryErrors.notFound('Delivery job not found.', { jobId: input.jobId });
    }
    // Scoping mismatch and genuine miss answer identically — no existence leakage.
    if (input.requireDriverId !== undefined && job.assignedDriverId !== input.requireDriverId) {
      throw DeliveryErrors.notFound('Delivery job not found.', { jobId: input.jobId });
    }

    const history = await this.jobs.listStatusHistory(job.id);

    return {
      jobId: job.id,
      orderId: job.orderId,
      fulfillmentId: job.fulfillmentId,
      status: job.status,
      driverId: job.assignedDriverId,
      timeline: {
        assignedAt: firstEntryInto(history, DeliveryJobStatus.ASSIGNED),
        arrivedPickupAt: firstEntryInto(history, DeliveryJobStatus.ARRIVED_PICKUP),
        // The two that *are* columns are read from the job, not from history: they are the
        // authoritative values other modules key off, and reading them from anywhere else would
        // let the two answers diverge.
        pickedUpAt: job.pickedUpAt,
        enRouteAt: firstEntryInto(history, DeliveryJobStatus.EN_ROUTE),
        arrivedDropoffAt: firstEntryInto(history, DeliveryJobStatus.ARRIVED_DROPOFF),
        deliveredAt: job.deliveredAt,
        completedAt: firstEntryInto(history, DeliveryJobStatus.COMPLETED),
        failedAt: firstEntryInto(history, DeliveryJobStatus.FAILED),
        cancelledAt: firstEntryInto(history, DeliveryJobStatus.CANCELLED),
      },
      history: history.map((entry) => ({
        from: entry.fromStatus,
        to: entry.toStatus,
        at: entry.createdAt,
        actorType: entry.actorType,
        reason: entry.reason ?? null,
      })),
    };
  }
}

/**
 * The **first** entry into a state, not the last.
 *
 * A job can re-enter `ASSIGNED` and `OFFERED` after a reassignment, and "when was this job first
 * assigned" is a different question from "when was it assigned to its current driver". The first
 * is what a delivery-duration measurement wants; the second is answerable from the history the
 * caller already has. Guessing the wrong one silently would make every duration measured from a
 * reassignment rather than from the start.
 */
function firstEntryInto(
  history: readonly { toStatus: DeliveryJobStatus; createdAt: Date }[],
  status: DeliveryJobStatus,
): Date | null {
  return history.find((entry) => entry.toStatus === status)?.createdAt ?? null;
}

function requireText(value: string, field: string): string {
  const text = (value ?? '').trim();
  if (!text) {
    throw DeliveryErrors.validation(`${field} is required.`, { field });
  }
  return text;
}
