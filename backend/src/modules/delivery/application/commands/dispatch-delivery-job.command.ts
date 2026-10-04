import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { AuditService } from '../../../../shared/audit/audit.service';
import { CONFIG_PORT, IConfigPort } from '../../../../shared/config/config.port';
import { DEFAULT_DELIVERY_OFFER_TTL_SECONDS } from '../../../../shared/config/delivery.config';
import { OutboxService, OutboxCapableClient } from '../../../../shared/outbox/outbox.service';
import { DeliveryJob, DeliveryJobProps } from '../../domain/entities/delivery-job.entity';
import {
  JobOffer,
  JobOfferProps,
  OFFER_EXPIRY_REASON,
} from '../../domain/entities/job-offer.entity';
import { DeliveryActorType, DeliveryJobStatus, JobOfferStatus } from '../../domain/enums';
import { jobOfferedEvent } from '../../domain/events';
import { DeliveryErrors } from '../../domain/errors';
import {
  DELIVERY_JOB_REPOSITORY,
  IDeliveryJobRepository,
} from '../../domain/repositories/delivery-job.repository';
import {
  IJobOfferRepository,
  JOB_OFFER_REPOSITORY,
} from '../../domain/repositories/job-offer.repository';
import { IUnitOfWork, UNIT_OF_WORK } from '../ports/unit-of-work.port';
import { DispatchCandidateService } from '../services/dispatch-candidate.service';
import { isUniqueConstraintViolation, runWithDeliveryRetry } from '../support/delivery-retry';

/** The config key for the offer TTL (§6.3). */
export const OFFER_TTL_CONFIG_KEY = 'delivery.offerTtlSeconds';

/**
 * What a dispatch attempt did. A **result**, not an exception — see `NoCandidate`.
 */
export const DispatchOutcome = {
  /** An offer was created and the job is now `OFFERED`. */
  Offered: 'OFFERED',
  /** A live, unexpired offer already exists. Nothing was done. */
  AlreadyOffered: 'ALREADY_OFFERED',
  /**
   * §6.5 / §12's `NO_DRIVER_AVAILABLE` condition, reached without failing the job.
   *
   * The job keeps its dispatchable status and can be offered again the moment somebody comes
   * online. `DeliveryStatusPolicy` deliberately defines no `OFFERED -> FAILED` and no
   * `CREATED -> FAILED` transition for exactly this reason: exhaustion is a condition to escalate
   * from, not an ending. A job that auto-failed here would strand an order a human could still
   * have dispatched, and nobody would be looking for it.
   */
  NoCandidate: 'NO_CANDIDATE',
} as const;

export type DispatchOutcome = (typeof DispatchOutcome)[keyof typeof DispatchOutcome];

export interface DispatchDeliveryJobInput {
  jobId: string;
  /**
   * Drivers this pass must not consider, beyond the ones the job's own history already excludes.
   * Used by reassignment to keep the job away from the driver it was taken from.
   */
  excludeDriverIds?: readonly string[];
  actorUserId?: string | null;
}

export interface DispatchDeliveryJobResult {
  outcome: DispatchOutcome;
  job: DeliveryJobProps;
  /** The offer created, or the live one already in place. `null` when nobody was eligible. */
  offer: JobOfferProps | null;
}

/** The states a job can be dispatched from (§3.3 F-STS-01, and `DeliveryStatusPolicy`'s table). */
const DISPATCHABLE_FROM: readonly DeliveryJobStatus[] = [
  DeliveryJobStatus.CREATED,
  // A job already OFFERED is re-dispatchable once its offer is answered or has expired: §6.4's
  // "offer next candidate" is a new `job_offers` round, not a job transition, which is why the
  // status policy has no `OFFERED -> OFFERED` self-loop and does not need one.
  DeliveryJobStatus.OFFERED,
  // §11.5: reassignment parks the job here, and dispatch is what gets it moving again.
  DeliveryJobStatus.REASSIGNING,
];

/**
 * `DispatchDeliveryJob` (§3.2 F-JOB-03, §6, §11.1, BR-DEL-02) — finds a driver and offers them
 * the job.
 *
 * ## One live offer at a time
 *
 * §6's own rationale: "sequential offer-with-TTL (vs broadcast-to-all) prevents race conditions on
 * acceptance and respects concurrent limits". Broadcasting a job to five drivers means four of
 * them are told about work that is not really available, and the one who taps first wins a race
 * the other four did not know they were in — which, repeated, is how drivers stop trusting the
 * app. It also makes the concurrent-job limit unenforceable at offer time, because five drivers
 * could each be at their limit for a different reason by the time they answer.
 *
 * The database enforces it: `job_offers_one_live_per_job` is a partial unique index over
 * `jobId WHERE status = 'OFFERED'`. Two dispatchers racing the same job cannot both insert.
 *
 * ## What it does with the offer already there
 *
 * - **Live and within its TTL** → nothing. `AlreadyOffered`. A redelivered `delivery.job.created`
 *   (ADR-010's at-least-once) must not retire a driver's offer out from under them.
 * - **Live but past its deadline** → expired, then the next candidate is offered. This is what
 *   makes correctness independent of any sweeper: the deadline is enforced by whoever looks next,
 *   not by a timer that might not fire.
 * - **None** → the next candidate is offered.
 *
 * ## Fresh selection, every time
 *
 * The candidate list is rebuilt on every pass — see `DispatchCandidateService` for why a stored
 * shortlist would be wrong. Drivers who have already been offered *this* job are excluded, so a
 * decline moves down the list rather than looping back to the same driver; when the list is
 * exhausted the result is `NoCandidate` and the job stays dispatchable.
 *
 * ## Atomicity
 *
 * The offer insert, the job transition, the status-history row, the audit entry and the
 * `JobOffered` outbox event all commit together at `Serializable` (ADR-013). An offer without its
 * job transition would let a second dispatcher offer the same job; a job transition without its
 * offer would leave a job `OFFERED` to nobody, waiting for a TTL that does not exist.
 *
 * The candidate selection deliberately sits **outside** that transaction: it is cross-module I/O
 * (ADR-014), and holding a `Serializable` transaction across an identity read would be both a
 * correctness and an availability defect. The in-transaction re-read is what makes that safe.
 */
@Injectable()
export class DispatchDeliveryJobCommand {
  constructor(
    @Inject(DELIVERY_JOB_REPOSITORY) private readonly jobs: IDeliveryJobRepository,
    @Inject(JOB_OFFER_REPOSITORY) private readonly offers: IJobOfferRepository,
    @Inject(UNIT_OF_WORK) private readonly uow: IUnitOfWork,
    @Inject(CONFIG_PORT) private readonly config: IConfigPort,
    private readonly candidates: DispatchCandidateService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  async execute(input: DispatchDeliveryJobInput): Promise<DispatchDeliveryJobResult> {
    const jobId = requireText(input.jobId, 'jobId');
    const now = new Date();

    const job = await this.jobs.findById(jobId);
    if (!job) {
      throw DeliveryErrors.notFound('Delivery job not found.', { jobId });
    }
    if (!DISPATCHABLE_FROM.includes(job.status)) {
      throw DeliveryErrors.jobNotDispatchable(jobId, job.status);
    }

    // An offer that is still live and still in time owns the job. Nothing else may touch it.
    const pending = await this.offers.findPendingForJob(jobId);
    if (pending && !JobOffer.rehydrate(pending).isExpiredAt(now)) {
      return { outcome: DispatchOutcome.AlreadyOffered, job, offer: pending };
    }

    const history = await this.offers.listForJob(jobId);
    const excluded = new Set<string>([
      ...history.map((offer) => offer.driverId),
      ...(input.excludeDriverIds ?? []),
    ]);

    const eligible = await this.candidates.findFor(job, excluded);
    if (!eligible) {
      await this.recordExhaustion(job, excluded.size, input.actorUserId ?? null);
      return { outcome: DispatchOutcome.NoCandidate, job, offer: null };
    }

    const round = (await this.offers.maxRoundForJob(jobId)) + 1;
    const offer = JobOffer.create({
      id: randomUUID(),
      jobId,
      driverId: eligible.candidate.driver.id,
      round,
      ttlSeconds: this.ttlSeconds(),
      now,
    }).toProps();

    try {
      return await runWithDeliveryRetry(this.uow, async (tx) => {
        // Re-read inside the transaction. Everything above was decided outside it, and a
        // concurrent dispatcher or an accept could have moved the job since.
        const current = await this.jobs.findById(jobId, tx);
        if (!current) {
          throw DeliveryErrors.notFound('Delivery job not found.', { jobId });
        }
        if (!DISPATCHABLE_FROM.includes(current.status)) {
          throw DeliveryErrors.jobNotDispatchable(jobId, current.status);
        }
        const live = await this.offers.findPendingForJob(jobId, tx);
        if (live && !JobOffer.rehydrate(live).isExpiredAt(now)) {
          return { outcome: DispatchOutcome.AlreadyOffered, job: current, offer: live };
        }
        if (live) {
          await this.retireExpired(live, tx);
        }

        const written = await this.offers.create(offer, tx);

        // The job moves to OFFERED only when it is not already there — §6.4's re-offer is a new
        // round, and the state machine has no self-loop to express it.
        let jobAfter = current;
        if (current.status !== DeliveryJobStatus.OFFERED) {
          const next = DeliveryJob.rehydrate(current).transitionTo(DeliveryJobStatus.OFFERED, {
            now,
          });
          const updated = await this.jobs.updateState(
            jobId,
            { status: current.status },
            { status: next.status },
            tx,
          );
          if (!updated) {
            // Somebody moved the job between the re-read and the write. Retry the whole thing.
            throw DeliveryErrors.jobAlreadyAssigned(jobId, current.status);
          }
          jobAfter = updated;
          await this.jobs.appendStatusHistory(
            {
              jobId,
              fromStatus: current.status,
              toStatus: next.status,
              actorType: DeliveryActorType.SYSTEM,
              actorId: input.actorUserId ?? null,
              reason: `Offered to driver ${written.driverId} (round ${written.round}).`,
            },
            tx,
          );
        }

        await this.audit.record(
          {
            actorUserId: input.actorUserId ?? null,
            action: 'DELIVERY_JOB_OFFERED',
            resourceType: 'DeliveryJob',
            resourceId: jobId,
            context: {
              offerId: written.id,
              // §13's "offered (to whom)".
              driverId: written.driverId,
              round: written.round,
              expiresAt: written.expiresAt.toISOString(),
              // The score's inputs, not just the score: an operator asking why this driver was
              // chosen needs to see the distance and the load.
              rank: eligible.rank,
              rankedCandidates: eligible.rankedCount,
              distanceMeters: eligible.candidate.distanceMeters,
              activeJobCount: eligible.candidate.activeJobCount,
              concurrentLimit: eligible.candidate.limit,
              excludedDrivers: excluded.size,
            },
          },
          tx,
        );

        await this.outbox.write(
          jobOfferedEvent({
            jobId,
            offerId: written.id,
            orderId: current.orderId,
            driverId: written.driverId,
            round: written.round,
            expiresAt: written.expiresAt.toISOString(),
          }),
          tx as OutboxCapableClient,
        );

        return { outcome: DispatchOutcome.Offered, job: jobAfter, offer: written };
      });
    } catch (err) {
      // Two dispatchers raced the partial unique index (one live offer per job) or the
      // `(jobId, round)` key. The loser returns the winner's offer rather than reporting a
      // conflict to an event handler that would only retry into it again.
      if (isUniqueConstraintViolation(err)) {
        const winner = await this.offers.findPendingForJob(jobId);
        const current = await this.jobs.findById(jobId);
        if (winner && current) {
          return { outcome: DispatchOutcome.AlreadyOffered, job: current, offer: winner };
        }
      }
      throw err;
    }
  }

  /**
   * Marks a past-deadline offer `EXPIRED` inside the caller's transaction.
   *
   * Compare-and-set through `respond`, so an accept that landed a microsecond earlier wins and
   * this becomes a no-op rather than overwriting it. `respondedAt` stays null — see
   * `JobOffer.expire`.
   */
  private async retireExpired(offer: JobOfferProps, tx: unknown): Promise<void> {
    await this.offers.respond(
      offer.id,
      {
        status: JobOfferStatus.EXPIRED,
        respondedAt: null,
        reason: OFFER_EXPIRY_REASON,
      },
      tx,
    );
  }

  /**
   * §6.5's escalation point, recorded rather than thrown.
   *
   * An audit entry is what an operator's "why has this job not moved?" query reads, and it is the
   * only durable trace that dispatch *tried*. Written in its own transaction because there is no
   * state change to co-locate it with — the job is deliberately unchanged.
   */
  private async recordExhaustion(
    job: DeliveryJobProps,
    excludedCount: number,
    actorUserId: string | null,
  ): Promise<void> {
    await this.audit.record({
      actorUserId,
      action: 'DELIVERY_JOB_NO_DRIVER_AVAILABLE',
      resourceType: 'DeliveryJob',
      resourceId: job.id,
      context: {
        orderId: job.orderId,
        pharmacyId: job.pharmacyId,
        status: job.status,
        alreadyOfferedTo: excludedCount,
      },
    });
  }

  private ttlSeconds(): number {
    const configured = this.config.get<number>(OFFER_TTL_CONFIG_KEY);
    return typeof configured === 'number' && Number.isInteger(configured) && configured > 0
      ? configured
      : DEFAULT_DELIVERY_OFFER_TTL_SECONDS;
  }
}

function requireText(value: string, field: string): string {
  const text = (value ?? '').trim();
  if (!text) {
    throw DeliveryErrors.validation(`${field} is required.`, { field });
  }
  return text;
}
