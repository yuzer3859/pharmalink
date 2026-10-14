import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { RequirePermissions } from '../../../../shared/rbac/permissions.decorator';
import {
  GetInventoryListingOperationsQuery,
  ListInventoryListingOperationsQuery,
} from '../../application/queries/inventory-listing-operations.queries';
import { ListInventoryListingOperationsQueryDto } from '../dtos/inventory-listing-operations.dto';
import {
  InventoryListingOperationsDetailResponse,
  InventoryListingOperationsListResponse,
  toInventoryListingOperationsDetailResponse,
  toInventoryListingOperationsListResponse,
} from '../dtos/inventory-listing-operations.response';

/**
 * Inventory listing visibility (module-16 Work 49) — read-only:
 *
 *     GET /admin/operations/inventory/listings              ?pharmacyId &branchId &catalogProductId &isEnabled
 *                                                           &hasStoredSellableStock &customerPurchasable &createdFrom &createdTo &page &size
 *     GET /admin/operations/inventory/listings/:listingId   one live listing, with stock diagnostics
 *
 * `pharmacy:read:any`, as Works 47 and 48. The id is UUID-validated, so no reserved segment can be read
 * as one. The stored `sellable` column is reported, never reconciled. Not audited.
 */
@Controller('admin/operations/inventory/listings')
@RequirePermissions('pharmacy:read:any')
export class AdminInventoryListingOperationsController {
  constructor(
    private readonly list: ListInventoryListingOperationsQuery,
    private readonly getOne: GetInventoryListingOperationsQuery,
  ) {}

  @Get()
  async search(@Query() q: ListInventoryListingOperationsQueryDto): Promise<InventoryListingOperationsListResponse> {
    const flag = (v?: 'true' | 'false') => (v === undefined ? undefined : v === 'true');
    return toInventoryListingOperationsListResponse(
      await this.list.execute({
        pharmacyId: q.pharmacyId,
        branchId: q.branchId,
        catalogProductId: q.catalogProductId,
        isEnabled: flag(q.isEnabled),
        hasStoredSellableStock: flag(q.hasStoredSellableStock),
        customerPurchasable: flag(q.customerPurchasable),
        createdFrom: q.createdFrom ? new Date(q.createdFrom) : undefined,
        createdTo: q.createdTo ? new Date(q.createdTo) : undefined,
        page: q.page,
        size: q.size,
      }),
    );
  }

  @Get(':listingId')
  async detail(@Param('listingId', new ParseUUIDPipe()) listingId: string): Promise<InventoryListingOperationsDetailResponse> {
    return toInventoryListingOperationsDetailResponse(await this.getOne.execute(listingId));
  }
}
