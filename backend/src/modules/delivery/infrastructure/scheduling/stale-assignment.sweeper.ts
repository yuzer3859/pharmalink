import { Inject, Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import { CONFIG_PORT, IConfigPort } from '../../../../shared/config/config.port';
import {
  DEFAULT_DELIVERY_RECOVERY_BATCH_SIZE,
  DEFAULT_DELIVERY_STALE_ASSIGNMENT_SECONDS,
} from '../../../../shared/config/delivery.config';
import { AppLogger } from '../../../../shared/logging/app-logger.service';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { DeliveryActorType, DeliveryJobStatus } from '../../domain/enums';
import {
  DELIVERY_JOB_REPOSITORY,
  IDeliveryJobRepository,
} from '../../domain/repositories/delivery-job.repository';
import { ReassignDeliveryJobCommand } from '../../application/commands/reassign-delivery-job.command';
import { RECOVERY_BATCH_SIZE_CONFIG_KEY } from './offer-expiry.sweeper';

/** The config key for how long a stale assignment is tolerated before it is reassigned. */
export const STALE_ASSIGNMENT_SECONDS_CONFIG_KEY = 'delivery.staleAssignmentSeconds';

/**
 * The only states from which a job may be taken off its driver.
 *
 * **Pre-pickup, and nothing else.** `DeliveryStatusPolicy` admits `REASSIGNING` from exactly these
 * two, so a mistake in this list could not move goods off a driver who is already carrying them —
 * `transitionTo` would refuse it. The list is still written out rather than derived, because a
 * worker that silently reassigns is the wrong place to discover a policy change: if a future state
 * became reassignable, somebody should have to decide whether *this* worker should act on it.
 */
const REASSIGNABLE: readonly DeliveryJobStatus[] = [
  DeliveryJobStatus.ASSIGNED,
  DeliveryJobStatus.ARRIVED_PICKUP,
];

/**
 * This worker's `SchedulerRegistry` key.
 *
 * A module-level const rather than a static on the class: a decorator argument is evaluated while
 * the class is still being defined, so it cannot read the class's own static field.
 */
export const STALE_ASSIGNMENT_CRON = 'delivery.stale-assignment';

/**
 * Releases pre-pickup jobs whose driver has stopped working, so they can be offered to somebody
 * else (§3.2 F-JOB-05, §11.5, BR-DEL-08).
 *
 * ## The gap this closes
 *
 * A driver can stop being dispatchable *after* they have taken a job. Three ways, and the
 * repository already handles two of them at the moment they happen:
 *
 *  - **Verification revoked before acceptance** — `AcceptJobOfferCommand` re-reads
 *    `IIdentityPort.getDriverIdentity` live and refuses the accept. Already closed.
 *  - **Offline before acceptance** — the same command refuses an accept from a driver who is not
 *    `ONLINE`/`BUSY` and on shift. Already closed.
 *  - **Offline *after* assignment** — nothing was watching. `ManageDriverShiftCommand` deliberately
 *    leaves open jobs alone when a shift ends ("releasing jobs here would strand medicines that are
 *    already in a bag with nobody assigned to them"), and it is right to: the release must find a
 *    replacement, which is reassignment's flow, not a shift's. But nothing then ran that flow.
 *
 * This worker runs it. It is the only one of the three that needed new behaviour, and it changes no
 * existing rule — it calls `ReassignDeliveryJobCommand`, which asks the state machine, which is
 * still the single place the pre-pickup boundary is written down.
 *
 * ## What it deliberately does not do
 *
 * It does not consume Module 01 suspension events, and it does not build a suspension workflow.
 * Eligibility remains Module 01's to answer and `IIdentityPort`'s to ask — this worker reads only
 * Module 08's *own* operational state, the driver's availability and shift, which this module owns
 * outright. A driver whose documents lapse mid-shift is still caught the moment they try to accept
 * anything; catching it sooner means reacting to Module 01 events, which is a contract that does
 * not exist yet and which §5 explicitly says not to invent.
 *
 * It also never touches a job at or past `PICKED_UP`. That is enforced twice: `REASSIGNABLE` above
 * does not select one, and `DeliveryJob.transitionTo` would refuse it if it did.
 *
 * ## Safety across instances
 *
 * The same claim-then-act shape as `DispatchRecoverySweeper`, for the same reasons: a short
 * read-only transaction locks a batch with `FOR UPDATE SKIP LOCKED` so concurrent instances take
 * disjoint sets, and the reassignment — which opens its own `Serializable` transaction and then
 * dispatches — runs outside it.
 *
 * Two workers that do reach the same job converge without either needing to know about the other.
 * `ReassignDeliveryJobCommand` compares both the status *and* the assigned driver in its
 * compare-and-set, so the second one finds the job already released and fails its expectation
 * rather than releasing it twice; the job ends up in `REASSIGNING` once, with one history row.
 */
@Injectable()
export class StaleAssignmentSweeper {
  private readonly logger = new AppLogger();

  constructor(
    private readonly prisma: PrismaService,
    @Inject(DELIVERY_JOB_REPOSITORY) private readonly jobs: IDeliveryJobRepository,
    @Inject(CONFIG_PORT) private readonly config: IConfigPort,
    private readonly reassign: ReassignDeliveryJobCommand,
  ) {
    this.logger.setContext(StaleAssignmentSweeper.name);
  }

  /**
   * One pass. Returns how many jobs were released from an inactive driver.
   *
   * Never throws, for the reason `OfferExpirySweeper.run` gives.
   */
  // Named, so the job is addressable in `SchedulerRegistry` — an unnamed `@Cron` is keyed by a
  // generated uuid, which neither an operator nor a test can identify.
  @Cron(CronExpression.EVERY_MINUTE, { name: STALE_ASSIGNMENT_CRON })
  async run(): Promise<number> {
    const staleSince = new Date(Date.now() - this.staleSeconds() * 1000);
    const jobIds = await this.claim(staleSince, this.batchSize());
    if (jobIds.length === 0) {
      return 0;
    }

    let released = 0;
    for (const jobId of jobIds) {
      if (await this.release(jobId)) {
        released += 1;
      }
    }

    if (released > 0) {
      this.logger.log(`Released ${released} pre-pickup job(s) from drivers who stopped working.`);
    }
    return released;
  }

  /** Locks a batch of candidates and commits. See `DispatchRecoverySweeper.claim`. */
  private async claim(staleSince: Date, limit: number): Promise<string[]> {
    try {
      return await this.prisma.$transaction(
        async (tx) => {
          const claimed: string[] = [];
          for (let i = 0; i < limit; i += 1) {
            const job = await this.jobs.lockNextStaleAssignment(
              REASSIGNABLE,
              staleSince,
              claimed,
              tx,
            );
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
      this.logger.error(`Failed to claim stale driver assignments: ${message(err)}`);
      return [];
    }
  }

  /**
   * Reassigns one job, outside the claim transaction.
   *
   * The reason is recorded on the status-history row and in the audit entry, because "why did this
   * job change hands?" is exactly what §13's trail is read for and "a background worker did it" is
   * not an answer. `SYSTEM` as the actor type says no human made this call.
   */
  private async release(jobId: string): Promise<boolean> {
    try {
      const result = await this.reassign.execute({
        jobId,
        reason: 'Assigned driver is no longer online and on shift.',
        actorUserId: null,
        actorType: DeliveryActorType.SYSTEM,
      });
      this.logger.log(
        `Job ${jobId} released from driver ${result.previousDriverId ?? '(none)'}; ` +
          `re-dispatch returned ${result.redispatch}.`,
      );
      return true;
    } catch (err) {
      // A job the driver advanced between the claim and here — to `PICKED_UP`, say — is refused by
      // the state machine, which is the correct answer: they came back and did the work.
      this.logger.error(`Reassigning stale job ${jobId} failed: ${message(err)}`);
      return false;
    }
  }

  private batchSize(): number {
    const configured = this.config.get<number>(RECOVERY_BATCH_SIZE_CONFIG_KEY);
    return typeof configured === 'number' && Number.isInteger(configured) && configured > 0
      ? configured
      : DEFAULT_DELIVERY_RECOVERY_BATCH_SIZE;
  }

  private staleSeconds(): number {
    const configured = this.config.get<number>(STALE_ASSIGNMENT_SECONDS_CONFIG_KEY);
    return typeof configured === 'number' && Number.isInteger(configured) && configured >= 0
      ? configured
      : DEFAULT_DELIVERY_STALE_ASSIGNMENT_SECONDS;
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
