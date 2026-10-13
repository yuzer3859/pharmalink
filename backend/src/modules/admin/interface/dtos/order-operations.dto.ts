import { Transform } from 'class-transformer';
import { IsDateString, IsEnum, IsIn, IsInt, IsOptional, Matches, Max, MaxLength, Min } from 'class-validator';
import { OrderStatus } from '../../../orders/application/ports/inbound/order-operations-read.port';
import { MAX_ORDER_OPERATIONS_PAGE_SIZE } from '../../application/queries/order-operations.queries';

/** An order reference is a short handle of letters, digits and dashes (e.g. `ORD-…`). */
const ORDER_NUMBER = /^[A-Za-z0-9-]+$/;

/**
 * `GET /admin/operations/orders` query string. Every filter is a column of `orders`, matched exactly
 * or as a window; there is no free-text search and no filter on any customer field.
 */
export class ListOrderOperationsQueryDto {
  @IsEnum(OrderStatus)
  @IsOptional()
  status?: OrderStatus;

  /** `true` / `false`. Kept as the raw string: implicit conversion would read `"false"` as `true`. */
  @Transform(({ obj }) => (obj as Record<string, unknown>).isCod)
  @IsIn(['true', 'false'])
  @IsOptional()
  isCod?: 'true' | 'false';

  /** Exact match on the order reference. */
  @Matches(ORDER_NUMBER)
  @MaxLength(64)
  @IsOptional()
  orderNumber?: string;

  @IsDateString()
  @IsOptional()
  createdFrom?: string;

  @IsDateString()
  @IsOptional()
  createdTo?: string;

  /**
   * Work 43: `true` / `false` — whether any fulfillment records a delivery-job reference. Raw string,
   * as `isCod`. A recorded reference only; `false` does not prove Module 08 has no job.
   */
  @Transform(({ obj }) => (obj as Record<string, unknown>).hasDeliveryJobReference)
  @IsIn(['true', 'false'])
  @IsOptional()
  hasDeliveryJobReference?: 'true' | 'false';

  @IsInt()
  @Min(1)
  @IsOptional()
  page?: number;

  @IsInt()
  @Min(1)
  @Max(MAX_ORDER_OPERATIONS_PAGE_SIZE)
  @IsOptional()
  size?: number;
}
