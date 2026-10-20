import { Controller, Get, Query } from '@nestjs/common';
import { RequirePermissions } from '../../../../shared/rbac/permissions.decorator';
import { ListOrderCancellationOperationsQuery } from '../../application/queries/order-cancellation-operations.queries';
import { ListOrderCancellationOperationsQueryDto } from '../dtos/order-cancellation-operations.dto';
import {
  OrderCancellationOperationsListResponse,
  toOrderCancellationOperationsListResponse,
} from '../dtos/order-cancellation-operations.response';

/**
 * Open customer cancellations (module-16, Work 55) — read-only:
 *
 *     GET /admin/operations/order-cancellations   ?state=PENDING|ATTENTION &page &size
 *
 * `order:read:any`, as Work 35's order operations. Its own prefix, so it can never be taken for
 * `/admin/operations/orders/:orderId`. Not audited; nothing is retried or resolved from here.
 */
@Controller('admin/operations/order-cancellations')
@RequirePermissions('order:read:any')
export class AdminOrderCancellationOperationsController {
  constructor(private readonly list: ListOrderCancellationOperationsQuery) {}

  @Get()
  async search(@Query() q: ListOrderCancellationOperationsQueryDto): Promise<OrderCancellationOperationsListResponse> {
    return toOrderCancellationOperationsListResponse(await this.list.execute({ state: q.state, page: q.page, size: q.size }));
  }
}
