import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  Min,
} from 'class-validator';

/** `POST /inventory/listings` (module-04 §5.3). */
export class CreateListingDto {
  @IsUUID()
  catalogProductId!: string;

  @IsUUID()
  branchId!: string;

  @IsInt()
  @Min(1)
  price!: number;

  @IsOptional()
  @IsIn(['ETB'])
  currency?: string;

  @IsString()
  @Length(1, 60)
  batchNumber!: string;

  @IsInt()
  @Min(1)
  initialQuantity!: number;

  @IsDateString()
  expiryDate!: string;

  @IsOptional()
  @IsString()
  supplier?: string;
}

/** `PATCH /inventory/listings/:id` (module-04 §5.3). */
export class UpdateListingDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  price?: number;

  @IsOptional()
  @IsBoolean()
  isEnabled?: boolean;
}

/** `POST /inventory/listings/:id/batches` (module-04 §5.3). */
export class AddBatchDto {
  @IsString()
  @Length(1, 60)
  batchNumber!: string;

  @IsInt()
  @Min(1)
  quantity!: number;

  @IsDateString()
  expiryDate!: string;

  @IsOptional()
  @IsString()
  supplier?: string;
}

/** `PATCH /inventory/batches/:id` — reason mandatory (module-04 §5.3). */
export class AdjustBatchDto {
  @IsInt()
  quantityDelta!: number;

  @IsString()
  @Length(3, 300)
  reason!: string;
}

export class ListListingsQueryDto {
  @IsOptional()
  @IsUUID()
  branchId?: string;

  @IsOptional()
  @IsUUID()
  catalogProductId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  size?: number = 20;
}

/**
 * `GET /inventory/listings/:id/movements` (module-04 §10.2) — same page/size validation
 * convention as `ListListingsQueryDto`/Module 03's `ListProductsQueryDto` (`page` >= 1, `size`
 * 1..50). Replaces the controller's previous manual `Number(query.page)`-style parsing of raw
 * `@Query('page')`/`@Query('size')` strings, which accepted any value (including negative page
 * numbers or an unbounded page size) with no validation.
 */
export class GetMovementsQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  size?: number = 20;
}
