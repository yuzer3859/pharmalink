import { Transform } from 'class-transformer';
import { IsDateString, IsEnum, IsIn, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { DeliveryJobStatus } from '../../../delivery/application/ports/inbound/delivery-operations-read.port';
import { MAX_DELIVERY_OPERATIONS_PAGE_SIZE } from '../../application/queries/delivery-operations.queries';

/**
 * `GET /admin/operations/deliveries` query string. Every filter is a column of `delivery_jobs`,
 * matched exactly or as a window; there is no free-text search and no filter on any address, driver
 * or customer field.
 */
export class ListDeliveryOperationsQueryDto {
  /** Module 08's own `DeliveryJobStatus`. */
  @IsEnum(DeliveryJobStatus)
  @IsOptional()
  status?: DeliveryJobStatus;

  /** Module 06 order id the jobs were created for. */
  @IsUUID()
  @IsOptional()
  orderId?: string;

  /** `true` / `false`. Kept as the raw string: implicit conversion would read `"false"` as `true`. */
  @Transform(({ obj }) => (obj as Record<string, unknown>).isCod)
  @IsIn(['true', 'false'])
  @IsOptional()
  isCod?: 'true' | 'false';

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
  @Max(MAX_DELIVERY_OPERATIONS_PAGE_SIZE)
  @IsOptional()
  size?: number;
}
