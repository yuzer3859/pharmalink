import { Transform } from 'class-transformer';
import { IsDateString, IsIn, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { MAX_STOCK_BATCH_PAGE_SIZE } from '../../application/queries/stock-batch-operations.queries';

/**
 * `GET /admin/operations/inventory/batches` query string: the batch's listing and that listing's fixed
 * owner, an expiry window, Module 04's expiry rule, and a created window. No batch-number or supplier
 * search, and no warning window — none exists in Module 04.
 */
export class ListStockBatchOperationsQueryDto {
  @IsUUID()
  @IsOptional()
  listingId?: string;

  @IsUUID()
  @IsOptional()
  pharmacyId?: string;

  @IsUUID()
  @IsOptional()
  branchId?: string;

  @IsUUID()
  @IsOptional()
  catalogProductId?: string;

  @IsDateString()
  @IsOptional()
  expiresFrom?: string;

  @IsDateString()
  @IsOptional()
  expiresTo?: string;

  /** `true` / `false` — expired at the response's `generatedAt` (`expiryDate <= generatedAt`). Raw string, as `isCod`. */
  @Transform(({ obj }) => (obj as Record<string, unknown>).isExpired)
  @IsIn(['true', 'false'])
  @IsOptional()
  isExpired?: 'true' | 'false';

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
  @Max(MAX_STOCK_BATCH_PAGE_SIZE)
  @IsOptional()
  size?: number;
}
