import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import { FulfillmentStatus } from '../../domain/enums';

/**
 * `GET /pharmacy/orders` (`06-orders-spec.md` §9.4). Carries **no** pharmacy or organization
 * parameter by design: scope is resolved server-side from the access token
 * (`ListPharmacyOrdersQuery`), so a client cannot widen it by naming another pharmacy's or
 * organization's id.
 */
export class ListPharmacyOrdersQueryDto {
  @IsOptional()
  @IsIn(Object.values(FulfillmentStatus))
  status?: FulfillmentStatus;

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
 * `POST /pharmacy/orders/:fulfillmentId/decline` (§9.4). The re-match that follows a decline
 * (BR-ORD-14/BRULE-19) is `DeclineFulfillmentCommand`'s responsibility; this DTO only carries the
 * pharmacist's stated reason.
 */
export class DeclineFulfillmentDto {
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;
}
