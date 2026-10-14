import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { RequirePermissions } from '../../../../shared/rbac/permissions.decorator';
import { GetStockBatchOperationsQuery, ListStockBatchOperationsQuery } from '../../application/queries/stock-batch-operations.queries';
import { ListStockBatchOperationsQueryDto } from '../dtos/stock-batch-operations.dto';
import {
  StockBatchOperationsDetailResponse,
  StockBatchOperationsListResponse,
  toStockBatchOperationsDetailResponse,
  toStockBatchOperationsListResponse,
} from '../dtos/stock-batch-operations.response';

/**
 * Stock batch and expiry visibility (module-16 Work 51) — read-only:
 *
 *     GET /admin/operations/inventory/batches            ?listingId &pharmacyId &branchId &catalogProductId &expiresFrom &expiresTo
 *                                                        &isExpired &createdFrom &createdTo &page &size
 *     GET /admin/operations/inventory/batches/:batchId   one batch of a live listing
 *
 * `pharmacy:read:any`, as Works 47–50. The id is UUID-validated, so no reserved segment can be read as
 * one. Not audited.
 */
@Controller('admin/operations/inventory/batches')
@RequirePermissions('pharmacy:read:any')
export class AdminStockBatchOperationsController {
  constructor(
    private readonly list: ListStockBatchOperationsQuery,
    private readonly getOne: GetStockBatchOperationsQuery,
  ) {}

  @Get()
  async search(@Query() q: ListStockBatchOperationsQueryDto): Promise<StockBatchOperationsListResponse> {
    const date = (v?: string) => (v ? new Date(v) : undefined);
    return toStockBatchOperationsListResponse(
      await this.list.execute({
        listingId: q.listingId,
        pharmacyId: q.pharmacyId,
        branchId: q.branchId,
        catalogProductId: q.catalogProductId,
        expiresFrom: date(q.expiresFrom),
        expiresTo: date(q.expiresTo),
        isExpired: q.isExpired === undefined ? undefined : q.isExpired === 'true',
        createdFrom: date(q.createdFrom),
        createdTo: date(q.createdTo),
        page: q.page,
        size: q.size,
      }),
    );
  }

  @Get(':batchId')
  async detail(@Param('batchId', new ParseUUIDPipe()) batchId: string): Promise<StockBatchOperationsDetailResponse> {
    return toStockBatchOperationsDetailResponse(await this.getOne.execute(batchId));
  }
}
