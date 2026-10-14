import { Transform } from 'class-transformer';
import { IsDateString, IsIn, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { MAX_LISTING_OPERATIONS_PAGE_SIZE } from '../../application/queries/inventory-listing-operations.queries';

const rawFlag = (key: string) => Transform(({ obj }) => (obj as Record<string, unknown>)[key]);

/**
 * `GET /admin/operations/inventory/listings` query string: owning ids, the stored enabled flag and
 * sellable column, Work 26's purchasability rule, and a created window. No free-text search.
 * Booleans are the raw strings `true` / `false`, as `isCod`.
 */
export class ListInventoryListingOperationsQueryDto {
  @IsUUID()
  @IsOptional()
  pharmacyId?: string;

  @IsUUID()
  @IsOptional()
  branchId?: string;

  @IsUUID()
  @IsOptional()
  catalogProductId?: string;

  /** The stored `isEnabled` flag. */
  @rawFlag('isEnabled')
  @IsIn(['true', 'false'])
  @IsOptional()
  isEnabled?: 'true' | 'false';

  /** The stored `sellable` column is above zero. */
  @rawFlag('hasStoredSellableStock')
  @IsIn(['true', 'false'])
  @IsOptional()
  hasStoredSellableStock?: 'true' | 'false';

  /** Work 26's customer-purchasability rule holds now. */
  @rawFlag('customerPurchasable')
  @IsIn(['true', 'false'])
  @IsOptional()
  customerPurchasable?: 'true' | 'false';

  @IsDateString()
  @IsOptional()
  createdFrom?: string;

  @IsDateString()
  @IsOptional()
  createdTo?: string;

  @IsInt()
  @Min(1)
  @IsOptional()
  page?: number;

  @IsInt()
  @Min(1)
  @Max(MAX_LISTING_OPERATIONS_PAGE_SIZE)
  @IsOptional()
  size?: number;
}
