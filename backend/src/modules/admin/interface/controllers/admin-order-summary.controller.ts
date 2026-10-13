import { Controller, Get } from '@nestjs/common';
import { RequirePermissions } from '../../../../shared/rbac/permissions.decorator';
import { GetOrderBacklogSummaryQuery } from '../../application/queries/get-order-backlog-summary.query';
import { OrderBacklogSummaryResponse, toOrderBacklogSummaryResponse } from '../dtos/order-backlog-summary.response';

/**
 * Order backlog and aging summary (module-16 Work 41) — read-only:
 *
 *     GET /admin/operations/orders/summary
 *
 * A controller of its own, registered in `AdminModule` **before** `AdminOrderOperationsController`,
 * so `summary` reaches this route rather than Work 35's `:orderId` (whose UUID pipe would refuse it).
 * `order:read:any`, as Work 35. Counts and timestamps only. Not audited.
 */
@Controller('admin/operations/orders/summary')
@RequirePermissions('order:read:any')
export class AdminOrderSummaryController {
  constructor(private readonly summary: GetOrderBacklogSummaryQuery) {}

  @Get()
  async get(): Promise<OrderBacklogSummaryResponse> {
    return toOrderBacklogSummaryResponse(await this.summary.execute());
  }
}
