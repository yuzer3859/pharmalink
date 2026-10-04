import { Inject, Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import { AuditService } from '../../../../shared/audit/audit.service';
import { CONFIG_PORT, IConfigPort } from '../../../../shared/config/config.port';
import { DEFAULT_DELIVERY_RECOVERY_BATCH_SIZE } from '../../../../shared/config/delivery.config';
import { AppLogger } from '../../../../shared/logging/app-logger.service';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { OFFER_EXPIRY_REASON } from '../../domain/entities/job-offer.entity';
import { JobOfferStatus } from '../../domain/enums';
import {
  IJobOfferRepository,
  JOB_OFFER_REPOSITORY,
} from '../../domain/repositories/job-offer.repository';
import { DispatchDeliveryJobCommand } from '../../application/commands/dispatch-delivery-job.command';

/** The config key for how many rows one tick may process. */
export const RECOVERY_BATCH_SIZE_CONFIG_KEY = 'delivery.recoveryBatchSize';

/**
 * This worker's `SchedulerRegistry` key.
 *
 * A module-level const rather than a static on the class: a decorator argument is evaluated while
 * the class is still being defined, so it cannot read the class's own static field.
 */
export const OFFER_EXPIRY_CRON = 'delivery.offer-expiry';

/**
 * Retires job offers whose TTL has passed, and gets the job moving again (§6.3, §6.4 — the
 * previously deferred persistent sweeper).
 *
 * ## Why this exists when dispatch already expires offers lazily
 *
 * `DispatchDeliveryJobCommand` retires a past-deadline offer whenever it encounters one, and that
 * is what makes *correctness* independent of any scheduler. But it only encounters one when
 * somebody dispatches, and there are two cases where nobody does:
 *
 *  - **The candidate list was exhausted.** Dispatch returns `NoCandidate` *before* opening its
 *    transaction, so the expired offer is never retired. Without this worker the row stays
 *    `OFFERED` indefinitely and the driver's handset keeps showing a job that is no longer theirs.
 *  - **Nothing else happens.** A job whose only driver let the offer lapse has no further trigger.
 *    The next dispatch is exactly what this worker provides.
 *
 * So the sweeper is not a duplicate of the lazy path; it is the thing that makes the lazy path's
 * *promptness* independent of luck. Expiry itself remains driven by the persisted `expiresAt`,
 * never by an in-memory timer — a restarted process re-reads the same deadlines and reaches the
 * same conclusions, which is the whole reason the deadline is a column.
 *
 * ## Safety across instances
 *
 * Each offer is claimed with `FOR UPDATE SKIP LOCKED` as the first statement of its own
 * transaction (`lockNextExpired`), so two instances sweeping simultaneously take *different* rows
 * rather than contending for the same one. The expiry write is a compare-and-set through
 * `respond`, so even if a lock were somehow not held, an accept that landed a microsecond earlier
 * still wins and the sweep becomes a no-op rather than overwriting a driver's answer.
 *
 * The follow-on dispatch runs **outside** that transaction. It has to: dispatch opens its own
 * `Serializable` transaction and performs cross-module candidate I/O (ADR-014), and calling it
 * while holding a row lock on the same job would be a deadlock waiting for load. Two workers that
 * both reach dispatch for the same job converge through the partial unique index
 * `job_offers_one_live_per_job` — one inserts, the other is handed the winner's offer as
 * `AlreadyOffered`. That is the same convergence the request path already relies on.
 *
 * ## Idempotency and restart
 *
 * Re-running a tick over an already-expired offer finds nothing: `lockNextExpired` selects only
 * `status = 'OFFERED'`, which the previous run cleared. A process that dies mid-tick has either
 * committed a row's expiry or not — there is no partial state, because each row is one
 * transaction — and the next tick picks up exactly where the last one stopped, from the database
 * rather than from anything the dead process was holding.
 */
@Injectable()
export class OfferExpirySweeper {
  private readonly logger = new AppLogger();

  constructor(
    private readonly prisma: PrismaService,
    @Inject(JOB_OFFER_REPOSITORY) private readonly offers: IJobOfferRepository,
    @Inject(CONFIG_PORT) private readonly config: IConfigPort,
    private readonly dispatch: DispatchDeliveryJobCommand,
    private readonly audit: AuditService,
  ) {
    this.logger.setContext(OfferExpirySweeper.name);
  }

  /**
   * One pass. Returns how many offers this tick retired — the number the e2e suite asserts on, and
   * the reason this is a method with a return value rather than a fire-and-forget.
   *
   * Never throws: a scheduled tick has no caller to handle an exception, and one bad row must not
   * stop the platform's dispatch recovery until the next minute.
   */
  // Named, so the job is addressable in `SchedulerRegistry` — an unnamed `@Cron` is keyed by a
  // generated uuid, which neither an operator nor a test can identify.
  @Cron(CronExpression.EVERY_MINUTE, { name: OFFER_EXPIRY_CRON })
  async run(): Promise<number> {
    const now = new Date();
    const limit = this.batchSize();
    // Rows this tick already failed on. Excluded from later reads so one permanently broken offer
    // — always the oldest, therefore always selected first — cannot starve the rest of the batch.
    const failed: string[] = [];
    let expired = 0;

    for (let i = 0; i < limit; i += 1) {
      const claimed = await this.expireNext(now, failed);
      if (claimed === 'none-left') {
        break;
      }
      if (typeof claimed === 'object' && 'failedOfferId' in claimed) {
        failed.push(claimed.failedOfferId);
        continue;
      }
      expired += 1;
      // Outside the expiry transaction, deliberately — see the class comment.
      await this.redispatch(claimed.jobId, claimed.offerId);
    }

    if (expired > 0) {
      this.logger.log(`Expired ${expired} job offer(s) past their TTL.`);
    }
    return expired;
  }

  /**
   * Claims and expires at most one offer, in its own transaction.
   *
   * `ReadCommitted` rather than `Serializable`: the row is already exclusively locked by the
   * `SELECT ... FOR UPDATE`, so there is no concurrent reader to serialize against, and paying for
   * `Serializable` here would add retry-on-conflict to a path whose conflicts are already resolved
   * by the lock.
   */
  private async expireNext(
    now: Date,
    excludeIds: readonly string[],
  ): Promise<{ offerId: string; jobId: string } | 'none-left' | { failedOfferId: string }> {
    let claimedId: string | null = null;
    try {
      const result = await this.prisma.$transaction(
        async (tx) => {
          const offer = await this.offers.lockNextExpired(now, excludeIds, tx);
          if (!offer) {
            return null;
          }
          claimedId = offer.id;

          // Compare-and-set. `null` means the offer was answered between the lock and here, which
          // a held lock makes nearly impossible but which costs nothing to honour — and the
          // honest answer to "an accept won" is to leave it alone, not to expire it.
          const answered = await this.offers.respond(
            offer.id,
            {
              status: JobOfferStatus.EXPIRED,
              // Null, because nobody responded. `JobOffer.expire` says the same thing: an expiry
              // is the absence of an answer, and stamping one would invent a driver action.
              respondedAt: null,
              reason: OFFER_EXPIRY_REASON,
            },
            tx,
          );
          if (!answered) {
            return null;
          }

          await this.audit.record(
            {
              actorUserId: null,
              action: 'DELIVERY_OFFER_EXPIRED',
              resourceType: 'JobOffer',
              resourceId: offer.id,
              context: {
                jobId: offer.jobId,
                driverId: offer.driverId,
                round: offer.round,
                expiresAt: offer.expiresAt.toISOString(),
                sweptAt: now.toISOString(),
              },
            },
            tx,
          );

          return { offerId: offer.id, jobId: offer.jobId };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
      );

      // `null` covers both "nothing eligible" and "somebody answered it first". Neither is an
      // error, and both mean this tick should stop looking rather than retry the same row.
      return result ?? 'none-left';
    } catch (err) {
      this.logger.error(
        `Failed to expire job offer ${claimedId ?? '(unknown)'}: ${message(err)}`,
      );
      return claimedId ? { failedOfferId: claimedId } : 'none-left';
    }
  }

  /**
   * §6.4's "offer next candidate", once the expiry has committed.
   *
   * Failures are logged and swallowed. A job that cannot be re-dispatched right now is not lost:
   * it has no live offer, so `DispatchRecoverySweeper` will find it on a later tick. Letting the
   * exception escape would abandon the rest of this tick's batch over one job's bad luck.
   */
  private async redispatch(jobId: string, offerId: string): Promise<void> {
    try {
      const result = await this.dispatch.execute({ jobId, actorUserId: null });
      this.logger.log(
        `Offer ${offerId} expired; re-dispatch of job ${jobId} returned ${result.outcome}.`,
      );
    } catch (err) {
      this.logger.error(`Re-dispatch after expiring offer ${offerId} failed: ${message(err)}`);
    }
  }

  private batchSize(): number {
    const configured = this.config.get<number>(RECOVERY_BATCH_SIZE_CONFIG_KEY);
    return typeof configured === 'number' && Number.isInteger(configured) && configured > 0
      ? configured
      : DEFAULT_DELIVERY_RECOVERY_BATCH_SIZE;
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
