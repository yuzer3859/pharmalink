import { Inject, Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { AppLogger } from '../../../../shared/logging/app-logger.service';
import {
  DELIVERY_JOB_REFERENCE_READ_PORT,
  IDeliveryJobReferenceReadPort,
} from '../../../delivery/application/ports/inbound/delivery-job-reference-read.port';
import { linkDeliveryJobReference } from '../../application/services/delivery-job-reference-linker';
import {
  DELIVERY_JOB_REFERENCE_CANDIDATE_REPOSITORY,
  IDeliveryJobReferenceCandidateRepository,
} from '../../domain/repositories/delivery-job-reference-candidate.repository';
import {
  FULFILLMENT_DELIVERY_JOB_LINK_REPOSITORY,
  IFulfillmentDeliveryJobLinkRepository,
} from '../../domain/repositories/fulfillment-delivery-job-link.repository';

/** This worker's `SchedulerRegistry` key (a module-level const, for the reason `DISPATCH_RECOVERY_CRON` gives). */
export const DELIVERY_JOB_REFERENCE_RECONCILE_CRON = 'orders.delivery-job-reference-reconcile';

/** Candidates examined per run. Bounded well under `MAX_DELIVERY_JOB_REFERENCE_LOOKUP`. */
export const DELIVERY_JOB_REFERENCE_RECONCILE_BATCH_SIZE = 100;

/** Safe, id-free counters for one run. */
export interface DeliveryJobReferenceReconcileReport {
  examined: number;
  populated: number;
  alreadyCorrect: number;
  conflicts: number;
  orderMismatches: number;
  /** No Module 08 job exists for the fulfillment (yet) — left for a later run. */
  noJob: number;
  /** Malformed ids, a fulfillment that vanished, or an exception on one record. */
  failures: number;
}

const empty = (): DeliveryJobReferenceReconcileReport => ({
  examined: 0, populated: 0, alreadyCorrect: 0, conflicts: 0, orderMismatches: 0, noJob: 0, failures: 0,
});

/**
 * Self-healing for `fulfillments.deliveryJobId` (Work 45).
 *
 * `DeliveryJobCreatedHandler` records the reference from Module 08's `delivery.job.created`, but
 * nothing retries it: `EventBusService` isolates a failed handler and `OutboxRelay` marks the event
 * published anyway. This worker closes that gap without touching either. Every five minutes it:
 *
 *  1. reads a bounded page of Module 06 fulfillments that can carry a job (`READY` / `DISPATCHED` /
 *     `DELIVERED`) and still have no reference — keyset-paged on `id`, continuing from where the last
 *     run stopped and wrapping to the start when it reaches the end, so fulfillments that never get a
 *     job cannot hold the same first page forever;
 *  2. asks Module 08, through its read-only `IDeliveryJobReferenceReadPort`, which jobs exist for
 *     exactly those fulfillments (identifiers only, one query);
 *  3. records each one with `linkDeliveryJobReference` — the very rule the event handler uses — passing
 *     the job's own `orderId`, so a job cut for another order is refused, a different existing
 *     reference is never overwritten, and a repeat is a no-op.
 *
 * It never creates a job, never derives an id from anything but Module 08's answer, writes only the
 * reference column, and emits no audit entry or event. A fulfillment Module 08 has no job for is left
 * alone for a later run.
 *
 * ## Failure and overlap
 *
 * `run()` never throws: a failed page (either read) is logged and the cursor is kept, so the next run
 * retries it; a failure on one record is counted and the rest of the page continues. A run that starts
 * while one is in progress in this process returns at once. Across instances, or against the event
 * handler and the maintenance script, overlap is harmless — every write is the same guarded
 * `WHERE deliveryJobId IS NULL` update, so the same job is recorded once and nothing is replaced.
 *
 * `npm run maintenance:backfill-delivery-job-refs` remains the operator's one-shot, set-based repair
 * for the whole table (same rules); this worker is the steady background version of it.
 */
@Injectable()
export class DeliveryJobReferenceReconciler {
  private cursor: string | null = null;
  private running = false;

  constructor(
    @Inject(DELIVERY_JOB_REFERENCE_CANDIDATE_REPOSITORY) private readonly candidates: IDeliveryJobReferenceCandidateRepository,
    @Inject(DELIVERY_JOB_REFERENCE_READ_PORT) private readonly jobs: IDeliveryJobReferenceReadPort,
    @Inject(FULFILLMENT_DELIVERY_JOB_LINK_REPOSITORY) private readonly links: IFulfillmentDeliveryJobLinkRepository,
    private readonly logger: AppLogger,
  ) {
    this.logger.setContext(DeliveryJobReferenceReconciler.name);
  }

  @Cron(CronExpression.EVERY_5_MINUTES, { name: DELIVERY_JOB_REFERENCE_RECONCILE_CRON })
  async run(batchSize = DELIVERY_JOB_REFERENCE_RECONCILE_BATCH_SIZE): Promise<DeliveryJobReferenceReconcileReport> {
    const report = empty();
    if (this.running) return report;
    this.running = true;
    try {
      let page;
      let found;
      try {
        page = await this.candidates.listUnreferenced(this.cursor, batchSize);
        if (page.length === 0 && this.cursor !== null) {
          // The previous page ended exactly at the last candidate: wrap now rather than spend a run empty.
          this.cursor = null;
          page = await this.candidates.listUnreferenced(null, batchSize);
        }
        found = page.length === 0 ? [] : await this.jobs.findByFulfillmentIds(page.map((c) => c.fulfillmentId));
      } catch (err) {
        report.failures += 1;
        this.logger.error({ message: 'Delivery job reference reconciliation failed to read a batch; it will be retried', error: errorText(err) });
        return report;
      }
      // Advance before writing: a full page continues from its last id, a short one wraps to the start.
      this.cursor = page.length === batchSize ? page[page.length - 1].fulfillmentId : null;

      const jobByFulfillment = new Map(found.map((j) => [j.fulfillmentId, j]));
      for (const candidate of page) {
        report.examined += 1;
        const job = jobByFulfillment.get(candidate.fulfillmentId);
        if (!job) {
          report.noJob += 1;
          continue;
        }
        try {
          const outcome = await linkDeliveryJobReference(this.links, { fulfillmentId: candidate.fulfillmentId, orderId: job.orderId, deliveryJobId: job.jobId });
          if (outcome === 'LINKED') report.populated += 1;
          else if (outcome === 'ALREADY_LINKED') report.alreadyCorrect += 1;
          else {
            if (outcome === 'CONFLICT') report.conflicts += 1;
            else if (outcome === 'ORDER_MISMATCH') report.orderMismatches += 1;
            else report.failures += 1;
            this.logger.error({ message: 'Delivery job reference not reconciled', outcome, fulfillmentId: candidate.fulfillmentId, jobId: job.jobId });
          }
        } catch (err) {
          report.failures += 1;
          this.logger.error({ message: 'Delivery job reference reconciliation failed for one fulfillment', fulfillmentId: candidate.fulfillmentId, error: errorText(err) });
        }
      }
      if (report.populated + report.conflicts + report.orderMismatches + report.failures > 0) {
        this.logger.log({ message: 'Delivery job reference reconciliation run', ...report });
      }
      return report;
    } finally {
      this.running = false;
    }
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
