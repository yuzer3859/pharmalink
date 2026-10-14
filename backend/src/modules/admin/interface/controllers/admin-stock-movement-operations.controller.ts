import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { RequirePermissions } from '../../../../shared/rbac/permissions.decorator';
import { GetStockMovementOperationsQuery, ListStockMovementOperationsQuery } from '../../application/queries/stock-movement-operations.queries';
import { ListStockMovementOperationsQueryDto } from '../dtos/stock-movement-operations.dto';
import {
  StockMovementOperationsListResponse,
  StockMovementOperationsResponse,
  toStockMovementOperationsListResponse,
  toStockMovementOperationsResponse,
} from '../dtos/stock-movement-operations.response';

/**
 * Inventory stock-movement history (module-16 Work 50) — read-only:
 *
 *     GET /admin/operations/inventory/movements               ?listingId &pharmacyId &branchId &batchId &type &createdFrom &createdTo &page &size
 *     GET /admin/operations/inventory/movements/:movementId   one recorded movement
 *
 * `pharmacy:read:any`, as Works 47–49. The id is UUID-validated, so no reserved segment can be read as
 * one. Not audited.
 */
@Controller('admin/operations/inventory/movements')
@RequirePermissions('pharmacy:read:any')
export class AdminStockMovementOperationsController {
  constructor(
    private readonly list: ListStockMovementOperationsQuery,
    private readonly getOne: GetStockMovementOperationsQuery,
  ) {}

  @Get()
  async search(@Query() q: ListStockMovementOperationsQueryDto): Promise<StockMovementOperationsListResponse> {
    return toStockMovementOperationsListResponse(
      await this.list.execute({
        listingId: q.listingId,
        pharmacyId: q.pharmacyId,
        branchId: q.branchId,
        batchId: q.batchId,
        type: q.type,
        createdFrom: q.createdFrom ? new Date(q.createdFrom) : undefined,
        createdTo: q.createdTo ? new Date(q.createdTo) : undefined,
        page: q.page,
        size: q.size,
      }),
    );
  }

  @Get(':movementId')
  async detail(@Param('movementId', new ParseUUIDPipe()) movementId: string): Promise<StockMovementOperationsResponse> {
    return toStockMovementOperationsResponse(await this.getOne.execute(movementId));
  }
}
