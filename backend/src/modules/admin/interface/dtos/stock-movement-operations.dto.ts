import { IsDateString, IsEnum, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { StockMovementType } from '../../../pharmacy-inventory/application/ports/inbound/stock-movement-operations-read.port';
import { MAX_STOCK_MOVEMENT_PAGE_SIZE } from '../../application/queries/stock-movement-operations.queries';

/**
 * `GET /admin/operations/inventory/movements` query string: stored movement columns (and the
 * listing's fixed owner), matched exactly or as a created window. No free-text search, and no filter on
 * the reason, the order/import reference, the reservation or the actor.
 */
export class ListStockMovementOperationsQueryDto {
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
  batchId?: string;

  /** Module 04's own `StockMovementType`. */
  @IsEnum(StockMovementType)
  @IsOptional()
  type?: StockMovementType;

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
  @Max(MAX_STOCK_MOVEMENT_PAGE_SIZE)
  @IsOptional()
  size?: number;
}
