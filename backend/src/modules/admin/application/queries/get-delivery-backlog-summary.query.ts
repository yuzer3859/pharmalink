import { Inject, Injectable } from '@nestjs/common';
import {
  DELIVERY_BACKLOG_SUMMARY_READ_PORT,
  DeliveryBacklogSummary,
  IDeliveryBacklogSummaryReadPort,
} from '../../../delivery/application/ports/inbound/delivery-backlog-summary-read.port';

/**
 * `GET /admin/operations/deliveries/summary` (module-16 Work 40): Module 08's delivery backlog and
 * aging counts, through `DELIVERY_BACKLOG_SUMMARY_READ_PORT`. Every definition is Module 08's;
 * nothing is computed here. Read-only; not audited.
 */
@Injectable()
export class GetDeliveryBacklogSummaryQuery {
  constructor(@Inject(DELIVERY_BACKLOG_SUMMARY_READ_PORT) private readonly deliveries: IDeliveryBacklogSummaryReadPort) {}

  execute(): Promise<DeliveryBacklogSummary> {
    return this.deliveries.summarizeBacklog();
  }
}
