import { Inject, Injectable } from '@nestjs/common';
import {
  IOrderBacklogSummaryReadPort,
  ORDER_BACKLOG_SUMMARY_READ_PORT,
  OrderBacklogSummary,
} from '../../../orders/application/ports/inbound/order-backlog-summary-read.port';

/**
 * `GET /admin/operations/orders/summary` (module-16 Work 41): Module 06's order backlog and aging
 * counts, through `ORDER_BACKLOG_SUMMARY_READ_PORT`. Every definition is Module 06's; nothing is
 * computed here. Read-only; not audited.
 */
@Injectable()
export class GetOrderBacklogSummaryQuery {
  constructor(@Inject(ORDER_BACKLOG_SUMMARY_READ_PORT) private readonly orders: IOrderBacklogSummaryReadPort) {}

  execute(): Promise<OrderBacklogSummary> {
    return this.orders.summarizeBacklog();
  }
}
