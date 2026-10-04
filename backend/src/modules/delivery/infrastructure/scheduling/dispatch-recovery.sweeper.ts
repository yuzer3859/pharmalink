import { Inject, Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import { CONFIG_PORT, IConfigPort } from '../../../../shared/config/config.port';
import {
  DEFAULT_DELIVERY_RECOVERY_BATCH_SIZE,
  DEFAULT_DELIVERY_RECOVERY_QUIET_SECONDS,
} from '../../../../shared/config/delivery.config';
import { AppLogger } from '../../../../shared/logging/app-logger.service';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { DeliveryJobStatus } from '../../domain/enums';
import {
  DELIVERY_JOB_REPOSITORY,
  IDeliveryJobRepository,
} from '../../domain/repositories/delivery-job.repository';
import {
  DispatchDeliveryJobCommand,
  DispatchOutcome,
} from '../../application/commands/dispatch-delivery-job.command';
import { RECOVERY_BATCH_SIZE_CONFIG_KEY } from './offer-expiry.sweeper';

/** The config key for how long a job must be quiet before recovery touches it. */
export const RECOVERY_QUIET_SECONDS_CONFIG_KEY = 'delivery.recoveryQuietSeconds';

/**
 * The states a job can be waiting for a driver in. Identical to `DispatchDeliveryJobCommand`'s own
 * `DISPATCHABLE_FROM`, and deliberately so: this worker's job is to re-run dispatch, not to have an
 * opinion about when dispatch is allowed. A state dispatch would refuse is one this worker must not
 * select, or every tick would log the same refusal forever.
 */
const RECOVERABLE: readonly DeliveryJobStatus[] = [
  DeliveryJobStatus.CREATED,
  DeliveryJobStatus.OFFERED,
  DeliveryJobStatus.REASSIGNING,
];

/**
 * This worker's `SchedulerRegistry` key.
 *
 * A module-level const rather than a static on the class: a decorator argument is evaluated while
 * the class is still being defined, so it cannot read the class's own static field.
 */
export const DISPATCH_RECOVERY_CRON = 'delivery.dispatch-recovery';

/**
 * Finds delivery jobs that want a driver and nobody is working on, and dispatches them again
 * (§6.5's `NO_DRIVER_AVAILABLE` recovery, §11.5's interrupted reassignment).
 *
 * ## The two gaps this closes, which are the same gap
 *
 * **No eligible driver.** `DispatchDeliveryJobCommand` answers `NoCandidate` — a *result*, not an
 * exception — records a `DELIVERY_JOB_NO_DRIVER_AVAILABLE` audit entry, and deliberately leaves
 * the job in its dispatchable state so it can be offered again "the moment somebody comes online".
 * Nothing was watching for that moment. This worker is what watches: the job keeps its status, and
 * every tick asks again until a driver exists. No new terminal state was invented, nothing failed
 * the delivery permanently, and the job is never stranded — which is exactly what §3 asks for, and
 * it is achieved by *scheduling*, not by changing the state machine.
 *
 * **An interrupted reassignment.** `ReassignDeliveryJobCommand` commits the release in one
 * transaction and re-dispatches in a second, because the candidate search is cross-module I/O that
 * must not run inside a `Serializable` transaction (ADR-014). A process that stops between the two
 * leaves a job in `REASSIGNING` with no driver and no offer. `REASSIGNING` is already documented as
 * "a durable state that says *this needs a driver*" — this worker is the thing that reads it.
 *
 * Both are one condition: *a job in a dispatchable state, with no live offer, that nobody has
 * touched recently*. One query, one worker.
 *
 * ## Why "nobody has touched recently" is part of the condition
 *
 * Dispatch and reassignment both pass briefly through exactly the state this worker looks for. A
 * worker with no quiet period would race live commands rather than recover from dead ones — it
 * would be correct (the partial unique index would sort out the duplicate offer) but it would be
 * doing redundant cross-module work on the platform's hottest path. `recoveryQuietSeconds`
 * separates *stalled* from *in flight*, and a job in flight is measured in milliseconds.
 *
 * ## Safety across instances
 *
 * Claiming and acting are separate, and that separation is the design rather than a compromise.
 * The claim is a single short transaction that locks up to a batch of candidate rows with
 * `FOR UPDATE SKIP LOCKED`; two instances claiming simultaneously therefore receive **disjoint**
 * sets. Dispatch then runs outside that transaction, because dispatch opens its own `Serializable`
 * transaction and calling it under a row lock on the same job would deadlock under load.
 *
 * Locks released at claim-commit mean two instances whose ticks are merely *staggered* can still
 * reach the same job. That is safe, and it is safe for a reason that predates this worker: the
 * partial unique index `job_offers_one_live_per_job` admits exactly one live offer, so the second
 * dispatcher is handed the winner's offer as `AlreadyOffered` and writes nothing. Two workers
 * converge on one authoritative result — one offer, one driver, one round.
 *
 * ## Restart and idempotency
 *
 * Nothing is held in memory between ticks. Every candidate is recomputed from `delivery_jobs` and
 * `job_offers` on each pass, so a process that dies mid-tick loses nothing a later tick will not
 * find again, and a tick that runs twice over the same job produces one offer rather than two.
 */
@Injectable()
export class DispatchRecoverySweeper {
  private readonly logger = new AppLogger();

  constructor(
    private readonly prisma: PrismaService,
    @Inject(DELIVERY_JOB_REPOSITORY) private readonly jobs: IDeliveryJobRepository,
    @Inject(CONFIG_PORT) private readonly config: IConfigPort,
    private readonly dispatch: DispatchDeliveryJobCommand,
  ) {
    this.logger.setContext(DispatchRecoverySweeper.name);
  }

  /**
   * One pass. Returns how many jobs this tick placed with a driver — `NoCandidate` is not counted,
   * because nothing changed and the job is expected back on the next tick.
   *
   * Never throws, for the reason `OfferExpirySweeper.run` gives.
   */
  // Named, so the job is addressable in `SchedulerRegistry` — an unnamed `@Cron` is keyed by a
  // generated uuid, which neither an operator nor a test can identify.
  @Cron(CronExpression.EVERY_MINUTE, { name: DISPATCH_RECOVERY_CRON })
  async run(): Promise<number> {
    const quietSince = new Date(Date.now() - this.quietSeconds() * 1000);
    const jobIds = await this.claim(quietSince, this.batchSize());
    if (jobIds.length === 0) {
      return 0;
    }

    let offered = 0;
    for (const jobId of jobIds) {
      const outcome = await this.redispatch(jobId);
      if (outcome === DispatchOutcome.Offered) {
        offered += 1;
      }
    }

    if (offered > 0) {
      this.logger.log(`Recovered ${offered} stalled delivery job(s) onto a driver.`);
    }
    return offered;
  }

  /**
   * Locks and returns up to `limit` stalled job ids, then commits — releasing the locks.
   *
   * The whole batch is locked inside **one** transaction so that a concurrent instance's claim
   * skips every row this one took, rather than only the first. Read-only: not a single write
   * happens here, which is what keeps the transaction short enough that holding N row locks is
   * cheap.
   */
  private async claim(quietSince: Date, limit: number): Promise<string[]> {
    try {
      return await this.prisma.$transaction(
        async (tx) => {
          const claimed: string[] = [];
          for (let i = 0; i < limit; i += 1) {
            const job = await this.jobs.lockNextStranded(RECOVERABLE, quietSince, claimed, tx);
            if (!job) {
              break;
            }
            claimed.push(job.id);
          }
          return claimed;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
      );
    } catch (err) {
      this.logger.error(`Failed to claim stalled delivery jobs: ${message(err)}`);
      return [];
    }
  }

  /**
   * Re-runs dispatch for one job, outside the claim transaction.
   *
   * Every outcome is expected and none is an error. `NoCandidate` in particular is the *normal*
   * result here — it means there is still nobody online, which is the condition this worker exists
   * to keep asking about — so it is logged at debug volume rather than treated as a failure.
   */
  private async redispatch(jobId: string): Promise<DispatchOutcome | null> {
    try {
      const result = await this.dispatch.execute({ jobId, actorUserId: null });
      if (result.outcome === DispatchOutcome.Offered) {
        this.logger.log(
          `Stalled job ${jobId} re-offered to driver ${result.offer?.driverId ?? '(unknown)'}.`,
        );
      }
      return result.outcome;
    } catch (err) {
      // A job that moved out of a dispatchable state between the claim and here (an operator
      // cancelled it, a concurrent dispatch placed it) raises `jobNotDispatchable`. That is a
      // healthy outcome of a lost race, not a fault, and the job is correctly no longer ours.
      this.logger.error(`Recovery dispatch for job ${jobId} failed: ${message(err)}`);
      return null;
    }
  }

  private batchSize(): number {
    const configured = this.config.get<number>(RECOVERY_BATCH_SIZE_CONFIG_KEY);
    return typeof configured === 'number' && Number.isInteger(configured) && configured > 0
      ? configured
      : DEFAULT_DELIVERY_RECOVERY_BATCH_SIZE;
  }

  private quietSeconds(): number {
    const configured = this.config.get<number>(RECOVERY_QUIET_SECONDS_CONFIG_KEY);
    return typeof configured === 'number' && Number.isInteger(configured) && configured >= 0
      ? configured
      : DEFAULT_DELIVERY_RECOVERY_QUIET_SECONDS;
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
