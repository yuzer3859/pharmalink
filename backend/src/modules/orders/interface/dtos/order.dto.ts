import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import { OrderStatus } from '../../domain/enums';

/**
 * `GET /orders` (`06-orders-spec.md` §9.3) — same page/size pagination convention as Module 05's
 * `ListPrescriptionsQueryDto` and Module 04's `ListListingsQueryDto`. `customerUserId` is never a
 * query parameter; the listing is scoped to the access token's subject.
 */
export class ListOrdersQueryDto {
  @IsOptional()
  @IsIn(Object.values(OrderStatus))
  status?: OrderStatus;

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
 * `POST /orders/:id/cancel` (§9.3). Whether the order's *current status* still permits
 * cancellation is `CancellationPolicy`'s decision (`CANCELLATION_NOT_ALLOWED`), not this DTO's —
 * only the reason's presence and shape are checked here.
 */
export class CancelOrderDto {
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;
}
