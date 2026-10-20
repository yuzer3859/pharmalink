import { Inject, Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { AppLogger } from '../../../../shared/logging/app-logger.service';
import { CancellationOutcome, OrderCancellationWorkflow } from '../../application/services/order-cancellation.workflow';
import {
  IOrderCancellationRequestRepository,
  ORDER_CANCELLATION_REQUEST_REPOSITORY,
} from '../../domain/repositories/order-cancellation-request.repository';

/** This worker's `SchedulerRegistry` key. */
export const ORDER_CANCELLATION_RECONCILE_CRON = 'orders.cancellation-reconcile';

/** Requests resumed per run. */
export const ORDER_CANCELLATION_RECONCILE_BATCH_SIZE = 50;

/** Safe, id-free counters for one run. */
export interface OrderCancellationReconcileReport {
  examined: number;
  completed: number;
  /** Order cancelled; the coupon step is still pending (retry or attention). */
  cancelledCouponPending: number;
  rejected: number;
  retryScheduled: number;
  attention: number;
  /** Another executor held (or took over) the lease. */
  busy: number;
  /** An exception escaped the workflow, or the page could not be read. */
  failures: number;
}

const empty = (): OrderCancellationReconcileReport => ({
  examined: 0, completed: 0, cancelledCouponPending: 0, rejected: 0, retryScheduled: 0, attention: 0, busy: 0, failures: 0,
});

const COUNTER: Record<CancellationOutcome, keyof OrderCancellationReconcileReport> = {
  COMPLETED: 'completed',
  ORDER_CANCELLED: 'cancelledCouponPending',
  REJECTED: 'rejected',
  PENDING: 'retryScheduled',
  ATTENTION: 'attention',
  BUSY: 'busy',
};

/**
 * Recovery for customer cancellations (Work 55), in the shape of Work 45's reference reconciler: it
 * reads only Module 06's own `order_cancellation_requests` — the durable intent — never another
 * module's ledger. Every five minutes it takes a bounded page of open requests that are due
 * (`nextAttemptAt` passed), not flagged for attention and not leased by a live executor, and drives
 * each through `OrderCancellationWorkflow.resume` — the same lease-guarded, idempotent steps the
 * request path runs. A request whose executor died is picked up once its lease expires.
 *
 * `run()` never throws. A run that starts while one is in progress in this process returns at once;
 * across instances (or against a customer retry) the per-request lease decides, so the same step is
 * never done twice. Transient failures back off inside the workflow; permanent ones are flagged and
 * logged, and stay visible in Module 16's cancellation view until an operator acts.
 */
@Injectable()
export class OrderCancellationReconciler {
  private readonly logger = new AppLogger();
  private running = false;

  constructor(
    @Inject(ORDER_CANCELLATION_REQUEST_REPOSITORY) private readonly requests: IOrderCancellationRequestRepository,
    private readonly workflow: OrderCancellationWorkflow,
  ) {
    this.logger.setContext(OrderCancellationReconciler.name);
  }

  @Cron(CronExpression.EVERY_5_MINUTES, { name: ORDER_CANCELLATION_RECONCILE_CRON })
  async run(batchSize = ORDER_CANCELLATION_RECONCILE_BATCH_SIZE): Promise<OrderCancellationReconcileReport> {
    const report = empty();
    if (this.running) return report;
    this.running = true;
    try {
      let due;
      try {
        due = await this.requests.listDue(new Date(), batchSize);
      } catch (err) {
        report.failures += 1;
        this.logger.error({ message: 'Order cancellation reconciliation failed to read due requests; it will be retried', error: errorText(err) });
        return report;
      }
      for (const request of due) {
        report.examined += 1;
        try {
          report[COUNTER[await this.workflow.resume(request.id)]] += 1;
        } catch (err) {
          report.failures += 1;
          this.logger.error({ message: 'Order cancellation reconciliation failed for one request', requestId: request.id, error: errorText(err) });
        }
      }
      if (report.examined > 0) {
        this.logger.log({ message: 'Order cancellation reconciliation run', ...report });
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
