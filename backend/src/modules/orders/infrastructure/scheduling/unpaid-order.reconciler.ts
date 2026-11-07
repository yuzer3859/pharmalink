import { Inject, Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { CONFIG_PORT, IConfigPort } from '../../../../shared/config/config.port';
import { AppLogger } from '../../../../shared/logging/app-logger.service';
import { PREPAID_CANCEL_REASONS, PrepaidPaymentService } from '../../application/services/prepaid-payment.service';
import { IOrderRepository, ORDER_REPOSITORY } from '../../domain/repositories/order.repository';

export const UNPAID_ORDER_RECONCILE_CRON = 'orders.unpaid-reconcile';
export const UNPAID_ORDER_RECONCILE_BATCH_SIZE = 50;

/** Minutes after placement before an unpaid prepaid order is cancelled: the stock hold's TTL plus a margin. */
export function unpaidOrderWindowMinutes(config: IConfigPort): number {
  const ttl = Number(config.get<number>('inventory.reservationTtlMinutes') ?? 15);
  return (Number.isFinite(ttl) && ttl > 0 ? ttl : 15) + 5;
}

export interface UnpaidOrderReconcileReport {
  examined: number;
  cancelled: number;
  skipped: number;
  failures: number;
}

/**
 * Work 95: a prepaid order whose payment never resolved (the customer abandoned the redirect, or
 * the gateway never answered) must not stay `PENDING_PAYMENT` forever. Once the window has
 * passed (the reservation TTL plus five minutes, when Module 04's sweeper has already expired the
 * holds), it is cancelled through the same compensation as a decline: stock released, coupon
 * reversed. An authorization that arrives later still is voided (`PrepaidPaymentService`).
 */
@Injectable()
export class UnpaidOrderReconciler {
  private readonly logger = new AppLogger();
  private running = false;

  constructor(
    @Inject(ORDER_REPOSITORY) private readonly orders: IOrderRepository,
    @Inject(CONFIG_PORT) private readonly config: IConfigPort,
    private readonly prepaid: PrepaidPaymentService,
  ) {
    this.logger.setContext(UnpaidOrderReconciler.name);
  }

  @Cron(CronExpression.EVERY_5_MINUTES, { name: UNPAID_ORDER_RECONCILE_CRON })
  async run(now = new Date(), batchSize = UNPAID_ORDER_RECONCILE_BATCH_SIZE): Promise<UnpaidOrderReconcileReport> {
    const report: UnpaidOrderReconcileReport = { examined: 0, cancelled: 0, skipped: 0, failures: 0 };
    if (this.running) return report;
    this.running = true;
    try {
      const cutoff = new Date(now.getTime() - unpaidOrderWindowMinutes(this.config) * 60_000);
      const due = await this.orders.listUnpaidPrepaid(cutoff, batchSize);
      for (const order of due) {
        report.examined += 1;
        try {
          const outcome = await this.prepaid.cancelUnpaid(order.id, PREPAID_CANCEL_REASONS.paymentTimeout);
          if (outcome === 'COMPLETED' || outcome === 'ORDER_CANCELLED') report.cancelled += 1;
          else report.skipped += 1;
        } catch (err) {
          report.failures += 1;
          this.logger.error({
            message: 'Could not cancel an unpaid prepaid order; it will be retried',
            orderId: order.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      if (report.examined > 0) this.logger.log({ message: 'Unpaid prepaid orders reconciled', ...report });
      return report;
    } catch (err) {
      report.failures += 1;
      this.logger.error({ message: 'Unpaid order reconciliation failed; it will be retried', error: err instanceof Error ? err.message : String(err) });
      return report;
    } finally {
      this.running = false;
    }
  }
}
