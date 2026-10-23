import { Inject, Injectable } from '@nestjs/common';
import {
  CancellationOperationsPage,
  CancellationOperationsState,
  IOrderCancellationOperationsReadPort,
  ORDER_CANCELLATION_OPERATIONS_READ_PORT,
} from '../../../orders/application/ports/inbound/order-cancellation-operations-read.port';

export const MAX_CANCELLATION_OPERATIONS_PAGE_SIZE = 100;
const DEFAULT_SIZE = 20;

/**
 * `GET /admin/operations/order-cancellations` (module-16, Work 55): open customer cancellations —
 * still retrying (`PENDING`) or stopped for an operator (`ATTENTION`) — through Module 06's
 * `ORDER_CANCELLATION_OPERATIONS_READ_PORT`. Paging clamped to 1..100 (default 20). Read-only.
 */
@Injectable()
export class ListOrderCancellationOperationsQuery {
  constructor(@Inject(ORDER_CANCELLATION_OPERATIONS_READ_PORT) private readonly cancellations: IOrderCancellationOperationsReadPort) {}

  execute(input: { state?: CancellationOperationsState; page?: number; size?: number }): Promise<CancellationOperationsPage> {
    const page = input.page && Number.isFinite(input.page) && input.page > 0 ? Math.floor(input.page) : 1;
    const size =
      input.size && Number.isFinite(input.size) && input.size > 0
        ? Math.min(Math.floor(input.size), MAX_CANCELLATION_OPERATIONS_PAGE_SIZE)
        : DEFAULT_SIZE;
    return this.cancellations.list({ state: input.state }, page, size);
  }
}
