import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../../../shared/audit/audit.service';
import { AppLogger } from '../../../../shared/logging/app-logger.service';
import { JobOffer, JobOfferProps } from '../../domain/entities/job-offer.entity';
import { JobOfferStatus } from '../../domain/enums';
import { DeliveryErrors } from '../../domain/errors';
import {
  DRIVER_PROFILE_REPOSITORY,
  IDriverProfileRepository,
} from '../../domain/repositories/driver-profile.repository';
import {
  IJobOfferRepository,
  JOB_OFFER_REPOSITORY,
} from '../../domain/repositories/job-offer.repository';
import { IUnitOfWork, UNIT_OF_WORK } from '../ports/unit-of-work.port';
import { runWithDeliveryRetry } from '../support/delivery-retry';
import {
  DispatchDeliveryJobCommand,
  DispatchOutcome,
} from './dispatch-delivery-job.command';

export interface DeclineJobOfferInput {
  /** Module 01 `users.id` of the declining driver. */
  userId: string;
  jobId: string;
  /** Optional free text from the handset — "too far", "finishing another run". */
  reason?: string | null;
}

export interface DeclineJobOfferResult {
  offer: JobOfferProps;
  /** What the immediate re-dispatch did. `null` when it could not be attempted. */
  redispatch: DispatchOutcome | null;
}

/**
 * `DeclineJobOffer` (§3.2 F-JOB-04, §6.4, BR-DEL-03) — the driver refuses, and the job moves on.
 *
 * ## The job does not change status
 *
 * It stays `OFFERED`, and the next candidate gets a new `job_offers` **round**. That is the
 * design's own model — §6.4's "decline/timeout → offer next candidate" — and it is why
 * `DeliveryStatusPolicy` has no `OFFERED -> OFFERED` self-loop and does not need one. Bouncing
 * the job back to `CREATED` on every decline would make its status history a sawtooth that says
 * nothing, and would lose the fact that dispatch has been trying continuously.
 *
 * ## Declining is never a dead end
 *
 * A declined offer is immediately followed by a re-dispatch, so a job cannot be left sitting with
 * no live offer and nobody looking at it. The two are **separate transactions** on purpose: the
 * decline is the driver's statement and must be recorded whatever happens next, while the
 * re-dispatch involves cross-module reads that ADR-014 keeps out of a `Serializable` transaction.
 *
 * That seam is safe because the resulting state is recoverable rather than wrong. If the decline
 * commits and the re-dispatch fails, the job is `OFFERED` with no live offer — which is exactly
 * the state a later dispatch pass, or the expiry sweep, picks up and resolves. The failure is
 * logged rather than thrown for the same reason: a driver who tapped "decline" has done their
 * part, and failing their request because the *next* driver could not be found would be reporting
 * somebody else's problem to the wrong person.
 */
@Injectable()
export class DeclineJobOfferCommand {
  constructor(
    @Inject(JOB_OFFER_REPOSITORY) private readonly offers: IJobOfferRepository,
    @Inject(DRIVER_PROFILE_REPOSITORY) private readonly profiles: IDriverProfileRepository,
    @Inject(UNIT_OF_WORK) private readonly uow: IUnitOfWork,
    private readonly dispatch: DispatchDeliveryJobCommand,
    private readonly audit: AuditService,
    private readonly logger: AppLogger,
  ) {
    this.logger.setContext(DeclineJobOfferCommand.name);
  }

  async execute(input: DeclineJobOfferInput): Promise<DeclineJobOfferResult> {
    const userId = requireText(input.userId, 'userId');
    const jobId = requireText(input.jobId, 'jobId');
    const now = new Date();

    const profile = await this.profiles.findByUserId(userId);
    if (!profile) {
      throw DeliveryErrors.driverProfileNotFound({ userId });
    }

    const pending = await this.offers.findPendingForJob(jobId);
    if (!pending || pending.driverId !== profile.id) {
      throw DeliveryErrors.offerNotFound({ jobId });
    }

    // The aggregate's rules, applied before any write: an expired offer cannot be declined either,
    // because declining it would claim a response the driver did not give in time and would
    // overwrite the `EXPIRED` the dispatcher is entitled to write.
    const declined = JobOffer.rehydrate(pending).decline(input.reason ?? null, now);
    const props = declined.toProps();

    const answered = await runWithDeliveryRetry(this.uow, async (tx) => {
      // Compare-and-set: an offer that was accepted or expired between the read and here is not
      // re-answered.
      const written = await this.offers.respond(
        pending.id,
        {
          status: JobOfferStatus.DECLINED,
          respondedAt: props.respondedAt,
          reason: props.reason,
        },
        tx,
      );
      if (!written) {
        throw DeliveryErrors.jobAlreadyAssigned(jobId, 'OFFER_ALREADY_ANSWERED');
      }

      await this.audit.record(
        {
          actorUserId: userId,
          action: 'DELIVERY_JOB_OFFER_DECLINED',
          resourceType: 'DeliveryJob',
          resourceId: jobId,
          context: {
            offerId: written.id,
            driverId: profile.id,
            driverUserId: userId,
            round: written.round,
            reason: written.reason,
          },
        },
        tx,
      );

      return written;
    });

    // No status history row: the job's status did not change. `delivery_status_history` is the
    // trail of *transitions* (§8), and writing a row that says `OFFERED -> OFFERED` would make it
    // a general-purpose event log and hide the real transitions among the noise. The decline's own
    // trail is the `job_offers` row and the audit entry above.

    return { offer: answered, redispatch: await this.redispatch(jobId) };
  }

  private async redispatch(jobId: string): Promise<DispatchOutcome | null> {
    try {
      const result = await this.dispatch.execute({ jobId });
      return result.outcome;
    } catch (err) {
      this.logger.error({
        message: 'Failed to re-dispatch after a decline',
        jobId,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }
}

function requireText(value: string, field: string): string {
  const text = (value ?? '').trim();
  if (!text) {
    throw DeliveryErrors.validation(`${field} is required.`, { field });
  }
  return text;
}
