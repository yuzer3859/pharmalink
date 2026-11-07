import { Inject, Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { AppLogger } from '../../../../shared/logging/app-logger.service';
import { CAPTURABLE_ORDER_STATUSES, PrepaidCaptureService } from '../../application/services/prepaid-capture.service';
import { IOrderRepository, ORDER_REPOSITORY } from '../../domain/repositories/order.repository';

export const PAYMENT_CAPTURE_RECONCILE_CRON = 'orders.payment-capture-reconcile';
export const PAYMENT_CAPTURE_RECONCILE_BATCH_SIZE = 50;

export interface PaymentCaptureReconcileReport {
  examined: number;
  captured: number;
  alreadyCaptured: number;
  failures: number;
}

/**
 * Work 96: retries capture for prepaid orders that reached fulfilment (`READY` or later) without a
 * recorded capture: the gateway was unreachable when `order.ready` was handled, or the process
 * stopped in between. A payment that cannot be captured (for example, already voided) keeps
 * failing here and is logged each run with its ids, for finance to resolve.
 */
@Injectable()
export class PaymentCaptureReconciler {
  private readonly logger = new AppLogger();
  private running = false;

  constructor(
    @Inject(ORDER_REPOSITORY) private readonly orders: IOrderRepository,
    private readonly capture: PrepaidCaptureService,
  ) {
    this.logger.setContext(PaymentCaptureReconciler.name);
  }

  @Cron(CronExpression.EVERY_5_MINUTES, { name: PAYMENT_CAPTURE_RECONCILE_CRON })
  async run(batchSize = PAYMENT_CAPTURE_RECONCILE_BATCH_SIZE): Promise<PaymentCaptureReconcileReport> {
    const report: PaymentCaptureReconcileReport = { examined: 0, captured: 0, alreadyCaptured: 0, failures: 0 };
    if (this.running) return report;
    this.running = true;
    try {
      const due = await this.orders.listUncapturedPrepaid([...CAPTURABLE_ORDER_STATUSES], batchSize);
      for (const order of due) {
        report.examined += 1;
        try {
          const outcome = await this.capture.capture(order.id);
          if (outcome === 'CAPTURED') report.captured += 1;
          else report.alreadyCaptured += 1;
        } catch (err) {
          report.failures += 1;
          this.logger.error({
            message: 'Capture retry failed for a prepaid order',
            orderId: order.id,
            paymentId: order.paymentId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      if (report.examined > 0) this.logger.log({ message: 'Prepaid payment captures reconciled', ...report });
      return report;
    } catch (err) {
      report.failures += 1;
      this.logger.error({ message: 'Payment capture reconciliation failed; it will be retried', error: err instanceof Error ? err.message : String(err) });
      return report;
    } finally {
      this.running = false;
    }
  }
}
