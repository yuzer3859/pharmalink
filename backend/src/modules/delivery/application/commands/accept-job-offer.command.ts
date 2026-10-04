import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../../../shared/audit/audit.service';
import { CONFIG_PORT, IConfigPort } from '../../../../shared/config/config.port';
import { DEFAULT_DELIVERY_MAX_CONCURRENT_JOBS } from '../../../../shared/config/delivery.config';
import { OutboxService, OutboxCapableClient } from '../../../../shared/outbox/outbox.service';
import { DeliveryJob, DeliveryJobProps } from '../../domain/entities/delivery-job.entity';
import { JobOffer, JobOfferProps } from '../../domain/entities/job-offer.entity';
import { DeliveryActorType, DeliveryJobStatus, JobOfferStatus } from '../../domain/enums';
import { jobAssignedEvent } from '../../domain/events';
import { DeliveryErrors } from '../../domain/errors';
import {
  DELIVERY_JOB_REPOSITORY,
  IDeliveryJobRepository,
} from '../../domain/repositories/delivery-job.repository';
import {
  DRIVER_PROFILE_REPOSITORY,
  IDriverProfileRepository,
} from '../../domain/repositories/driver-profile.repository';
import {
  IJobOfferRepository,
  JOB_OFFER_REPOSITORY,
} from '../../domain/repositories/job-offer.repository';
import {
  hasCapacity,
  isWorkingAvailability,
  resolveConcurrentLimit,
} from '../../domain/services/driver-availability-policy';
import { IIdentityPort, IDENTITY_PORT } from '../ports/outbound/identity.port';
import { IUnitOfWork, UNIT_OF_WORK } from '../ports/unit-of-work.port';
import { MAX_CONCURRENT_JOBS_CONFIG_KEY } from '../queries/get-driver-operational-status.query';
import { runWithDeliveryRetry } from '../support/delivery-retry';

export interface AcceptJobOfferInput {
  /** Module 01 `users.id` of the accepting driver — what an access token carries. */
  userId: string;
  /** The job being accepted. §9.2's route is `POST /delivery/jobs/{id}/accept`. */
  jobId: string;
}

export interface AcceptJobOfferResult {
  job: DeliveryJobProps;
  offer: JobOfferProps;
}

/**
 * `AcceptJobOffer` (§3.2 F-JOB-04, §11.2, BR-DEL-03, BRULE-28) — the driver takes the job.
 *
 * ## Every check, and why each one is here and not somewhere else
 *
 * 1. **The offer is this driver's.** Resolved from the authenticated user id, never from the
 *    request: the route names a job, and which offer that means is decided from the token. A job
 *    whose live offer belongs to somebody else answers `NOT_FOUND`, not `FORBIDDEN`, so job ids
 *    cannot be probed to discover who is being dispatched what.
 * 2. **The offer is still pending.** Enforced twice — by the aggregate, and by a compare-and-set
 *    on the row, which is the half that survives two requests arriving together.
 * 3. **The deadline has not passed**, against the stored `expiresAt` at the moment of the attempt.
 *    An offer whose row still says `OFFERED` because no sweeper has run is still refused.
 * 4. **The driver is still operationally available** — still online, still on shift. Checked now,
 *    not when the offer was made: a driver can go offline in the TTL, and a job assigned to a
 *    driver who has closed the app is a job nobody is carrying.
 * 5. **Module 01 still says they are verified** (BRULE-09). Re-read live, because the interval
 *    between an offer and its acceptance is an interval in which an approval can be revoked, and
 *    because there is deliberately no cached copy of this answer anywhere in Module 08.
 * 6. **The concurrent-job limit** (BRULE-28), counted *at acceptance* — §11.2 puts the guard
 *    inside the accept transaction for a concrete reason: the gap between offer and accept is
 *    exactly long enough for the driver to have accepted something else, and the offer-time check
 *    would happily let them exceed the limit by one job every time.
 * 7. **The job is still `OFFERED`.** The compare-and-set that enforces this is what makes a single
 *    assignment a guarantee rather than a hope.
 *
 * ## Why only one accept can win
 *
 * Two compare-and-sets inside one `Serializable` transaction (ADR-013). The offer moves only while
 * it is `OFFERED`; the job moves only while it is `OFFERED`. Whichever transaction commits first
 * takes both, and the second finds neither and is told the job is already taken. Serializable
 * isolation additionally stops the *counts* the limit check read from being stale — two accepts by
 * the same driver for two different jobs cannot both observe the same free slot.
 */
@Injectable()
export class AcceptJobOfferCommand {
  constructor(
    @Inject(DELIVERY_JOB_REPOSITORY) private readonly jobs: IDeliveryJobRepository,
    @Inject(JOB_OFFER_REPOSITORY) private readonly offers: IJobOfferRepository,
    @Inject(DRIVER_PROFILE_REPOSITORY) private readonly profiles: IDriverProfileRepository,
    @Inject(IDENTITY_PORT) private readonly identity: IIdentityPort,
    @Inject(UNIT_OF_WORK) private readonly uow: IUnitOfWork,
    @Inject(CONFIG_PORT) private readonly config: IConfigPort,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  async execute(input: AcceptJobOfferInput): Promise<AcceptJobOfferResult> {
    const userId = requireText(input.userId, 'userId');
    const jobId = requireText(input.jobId, 'jobId');
    const now = new Date();

    const profile = await this.profiles.findByUserId(userId);
    if (!profile) {
      throw DeliveryErrors.driverProfileNotFound({ userId });
    }

    const pending = await this.offers.findPendingForJob(jobId);
    // Both "no live offer" and "somebody else's live offer" answer identically — see the class
    // comment on existence leakage.
    if (!pending || pending.driverId !== profile.id) {
      throw DeliveryErrors.offerNotFound({ jobId });
    }

    const offer = JobOffer.rehydrate(pending);
    if (offer.isExpiredAt(now)) {
      throw DeliveryErrors.offerExpired(offer.id, offer.expiresAt);
    }

    // Still working? A driver who went offline during the TTL is not assigned the job.
    if (!isWorkingAvailability(profile.availability) || profile.shiftStartedAt === null) {
      throw DeliveryErrors.availabilityConflict(
        'You must be online and on shift to accept a delivery.',
        { availability: profile.availability, onShift: profile.shiftStartedAt !== null },
      );
    }

    // BRULE-09, re-read live. Outside the transaction per ADR-014 — it is cross-module I/O, and
    // nothing the transaction does can change the answer.
    const identity = await this.identity.getDriverIdentity(userId);
    if (!identity.isEligible) {
      throw DeliveryErrors.driverNotVerified(userId, identity.reason ?? 'UNKNOWN');
    }

    const limit = resolveConcurrentLimit(profile.maxConcurrent, this.platformLimit());

    return runWithDeliveryRetry(this.uow, async (tx) => {
      // BRULE-28, counted inside the transaction against the jobs themselves. At Serializable,
      // two accepts by this driver cannot both see the same free slot.
      const activeJobCount = await this.jobs.countActiveJobs(profile.id, tx);
      if (!hasCapacity(activeJobCount, limit)) {
        throw DeliveryErrors.concurrentLimitReached(activeJobCount, limit);
      }

      const current = await this.jobs.findById(jobId, tx);
      if (!current) {
        throw DeliveryErrors.notFound('Delivery job not found.', { jobId });
      }
      if (current.status !== DeliveryJobStatus.OFFERED) {
        throw DeliveryErrors.jobAlreadyAssigned(jobId, current.status);
      }
      // Belt and braces against a reassignment that somehow left the driver attached: assigning a
      // job to the driver who already holds it would double-count their capacity.
      if (current.assignedDriverId === profile.id) {
        throw DeliveryErrors.jobAlreadyAssigned(jobId, current.status);
      }

      // Compare-and-set #1: the offer moves only while it is still pending.
      const answered = await this.offers.respond(
        offer.id,
        {
          status: JobOfferStatus.ACCEPTED,
          respondedAt: now,
          reason: null,
        },
        tx,
      );
      if (!answered) {
        throw DeliveryErrors.jobAlreadyAssigned(jobId, current.status);
      }

      // Compare-and-set #2: the job moves only while it is still OFFERED. The aggregate proves
      // the transition legal and requires the driver id; the repository makes it atomic.
      const assigned = DeliveryJob.rehydrate(current).transitionTo(DeliveryJobStatus.ASSIGNED, {
        assignedDriverId: profile.id,
        now,
      });
      const written = await this.jobs.updateState(
        jobId,
        // The job must still be OFFERED *and* still unassigned: a reassignment that landed in
        // between leaves the status alone but changes who holds it.
        { status: DeliveryJobStatus.OFFERED, assignedDriverId: null },
        { status: assigned.status, assignedDriverId: profile.id },
        tx,
      );
      if (!written) {
        throw DeliveryErrors.jobAlreadyAssigned(jobId, current.status);
      }

      await this.jobs.appendStatusHistory(
        {
          jobId,
          fromStatus: DeliveryJobStatus.OFFERED,
          toStatus: DeliveryJobStatus.ASSIGNED,
          actorType: DeliveryActorType.DRIVER,
          actorId: profile.id,
          reason: `Accepted offer ${offer.id} (round ${offer.round}).`,
          // §13's "with geo": where the driver was when they took it on.
          lat: profile.lastLocation?.lat ?? null,
          lng: profile.lastLocation?.lng ?? null,
        },
        tx,
      );

      await this.audit.record(
        {
          actorUserId: userId,
          action: 'DELIVERY_JOB_ASSIGNED',
          resourceType: 'DeliveryJob',
          resourceId: jobId,
          context: {
            offerId: offer.id,
            driverId: profile.id,
            driverUserId: userId,
            round: offer.round,
            // The limit check's own figures, so a later "how did they end up with three?" has an
            // answer rather than an inference.
            activeJobCountBefore: activeJobCount,
            concurrentLimit: limit,
          },
        },
        tx,
      );

      await this.outbox.write(
        jobAssignedEvent({
          jobId,
          offerId: offer.id,
          orderId: current.orderId,
          driverId: profile.id,
        }),
        tx as OutboxCapableClient,
      );

      return { job: written, offer: answered };
    });
  }

  private platformLimit(): number {
    const configured = this.config.get<number>(MAX_CONCURRENT_JOBS_CONFIG_KEY);
    return typeof configured === 'number' && Number.isInteger(configured) && configured > 0
      ? configured
      : DEFAULT_DELIVERY_MAX_CONCURRENT_JOBS;
  }
}

function requireText(value: string, field: string): string {
  const text = (value ?? '').trim();
  if (!text) {
    throw DeliveryErrors.validation(`${field} is required.`, { field });
  }
  return text;
}
