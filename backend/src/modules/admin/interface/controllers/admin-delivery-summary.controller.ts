import { Controller, Get } from '@nestjs/common';
import { RequirePermissions } from '../../../../shared/rbac/permissions.decorator';
import { GetDeliveryBacklogSummaryQuery } from '../../application/queries/get-delivery-backlog-summary.query';
import { DeliveryBacklogSummaryResponse, toDeliveryBacklogSummaryResponse } from '../dtos/delivery-backlog-summary.response';

/**
 * Delivery backlog and aging summary (module-16 Work 40) — read-only:
 *
 *     GET /admin/operations/deliveries/summary
 *
 * A controller of its own, registered in `AdminModule` **before** `AdminDeliveryOperationsController`,
 * so `summary` reaches this route rather than Work 36's `:deliveryJobId` (whose UUID pipe would
 * refuse it). `delivery:read:any`, as Work 36. Counts and timestamps only. Not audited.
 */
@Controller('admin/operations/deliveries/summary')
@RequirePermissions('delivery:read:any')
export class AdminDeliverySummaryController {
  constructor(private readonly summary: GetDeliveryBacklogSummaryQuery) {}

  @Get()
  async get(): Promise<DeliveryBacklogSummaryResponse> {
    return toDeliveryBacklogSummaryResponse(await this.summary.execute());
  }
}
