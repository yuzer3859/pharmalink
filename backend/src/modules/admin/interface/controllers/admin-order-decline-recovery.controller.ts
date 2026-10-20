import { Controller, Get, Query } from '@nestjs/common';
import { RequirePermissions } from '../../../../shared/rbac/permissions.decorator';
import { ListOrderDeclineRecoveryQuery } from '../../application/queries/order-decline-recovery.queries';
import { ListOrderDeclineRecoveryQueryDto } from '../dtos/order-decline-recovery.dto';
import {
  OrderDeclineRecoveryListResponse,
  toOrderDeclineRecoveryListResponse,
} from '../dtos/order-decline-recovery.response';

/**
 * Pharmacy-decline recovery (module-16, Work 55) — read-only, derived from existing order, fulfillment
 * and reservation state:
 *
 *     GET /admin/operations/order-decline-recovery   ?state=PENDING_CONFIRMATION|CONFIRMATION_FAILED|ORPHANED|RESOLVED &page &size
 *
 * Paged over candidate orders: `totalOrders` is global; `pageCounts` (`countsScope: CURRENT_PAGE`) counts
 * only the segments of the page's orders — global per-state counts would need every candidate's
 * reservations from Module 04 on each request, an unbounded cross-module read.
 *
 * `order:read:any`, as Work 35's order operations. Its own prefix (never taken for
 * `/admin/operations/orders/:orderId`). Not audited; nothing is confirmed, re-matched or re-pointed here.
 */
@Controller('admin/operations/order-decline-recovery')
@RequirePermissions('order:read:any')
export class AdminOrderDeclineRecoveryController {
  constructor(private readonly list: ListOrderDeclineRecoveryQuery) {}

  @Get()
  async search(@Query() q: ListOrderDeclineRecoveryQueryDto): Promise<OrderDeclineRecoveryListResponse> {
    return toOrderDeclineRecoveryListResponse(await this.list.execute({ state: q.state, page: q.page, size: q.size }));
  }
}
