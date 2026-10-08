import { Controller, Get } from '@nestjs/common';
import { RequirePermissions } from '../../../../shared/rbac/permissions.decorator';
import { GetInventoryOperationsOverviewQuery } from '../../application/queries/get-inventory-operations-overview.query';
import { InventoryOperationsOverviewResponse, toInventoryOperationsOverviewResponse } from '../dtos/inventory-operations.response';

/**
 * Operational visibility of the pharmacy network and its inventory (module-16 Work 25).
 *
 *     GET /admin/operations/inventory/overview   pharmacies, inventory listings, catalogue products — now
 *
 * Read-only, structurally: one `@Get`, over three read ports (Module 04's provider analytics and
 * stock availability, Module 03's catalogue analytics), none of which can move stock or change a
 * status. `analytics:read`, Work 08's key for read-only operational counts — ADMIN, SUPER_ADMIN by
 * wildcard. Not audited (no sensitive-read convention; aggregate counts).
 */
@Controller('admin/operations')
@RequirePermissions('analytics:read')
export class AdminOperationsController {
  constructor(private readonly inventoryOverview: GetInventoryOperationsOverviewQuery) {}

  @Get('inventory/overview')
  async getInventoryOverview(): Promise<InventoryOperationsOverviewResponse> {
    return toInventoryOperationsOverviewResponse(await this.inventoryOverview.execute());
  }
}
