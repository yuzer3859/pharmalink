import { Transform } from 'class-transformer';
import { IsDateString, IsEnum, IsIn, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { FulfillmentStatus } from '../../../orders/application/ports/inbound/fulfillment-operations-read.port';
import { MAX_FULFILLMENT_OPERATIONS_PAGE_SIZE } from '../../application/queries/fulfillment-operations.queries';

/**
 * `GET /admin/operations/fulfillments` query string. Every filter is a column of `fulfillments`,
 * matched exactly or as a window; there is no free-text search.
 */
export class ListFulfillmentOperationsQueryDto {
  /** Module 06's own `FulfillmentStatus`. */
  @IsEnum(FulfillmentStatus)
  @IsOptional()
  status?: FulfillmentStatus;

  @IsUUID()
  @IsOptional()
  orderId?: string;

  @IsUUID()
  @IsOptional()
  pharmacyId?: string;

  @IsUUID()
  @IsOptional()
  branchId?: string;

  /** `true` / `false` — whether a delivery-job id is recorded. Raw string, as `isCod`; `false` does not prove Module 08 has no job. */
  @Transform(({ obj }) => (obj as Record<string, unknown>).hasDeliveryJobReference)
  @IsIn(['true', 'false'])
  @IsOptional()
  hasDeliveryJobReference?: 'true' | 'false';

  @IsDateString()
  @IsOptional()
  createdFrom?: string;

  @IsDateString()
  @IsOptional()
  createdTo?: string;

  @IsDateString()
  @IsOptional()
  readyFrom?: string;

  @IsDateString()
  @IsOptional()
  readyTo?: string;

  @IsInt()
  @Min(1)
  @IsOptional()
  page?: number;

  @IsInt()
  @Min(1)
  @Max(MAX_FULFILLMENT_OPERATIONS_PAGE_SIZE)
  @IsOptional()
  size?: number;
}
