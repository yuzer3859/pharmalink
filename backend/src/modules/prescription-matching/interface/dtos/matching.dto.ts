import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsInt,
  IsLatitude,
  IsLongitude,
  IsOptional,
  IsUUID,
  Min,
  ValidateNested,
} from 'class-validator';

/** One cart line, reused by `FindMatchDto`/`SelectMatchDto`/`RematchDto` (module-05 §5.5). */
export class OrderLineDto {
  @IsUUID()
  catalogProductId!: string;

  @IsInt()
  @Min(1)
  quantity!: number;
}

/** `POST /matching/find` (module-05 §5.5). */
export class FindMatchDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => OrderLineDto)
  lines!: OrderLineDto[];

  @IsOptional()
  @IsLatitude()
  deliveryLat?: number;

  @IsOptional()
  @IsLongitude()
  deliveryLng?: number;
}

/**
 * `POST /matching/:id/select` (module-05 §5.5). **Deviation from the spec's literal
 * `{ pharmacyId? }` shape (flagged, not silently guessed — see
 * `SelectMatchCommand`'s own doc comment):** `SelectMatchCommand`/`RematchCommand` need the
 * original requested lines again to resolve a `listingId` per line and call
 * `IInventoryPort.reserve()`, since `match_candidates` only persists the aggregate ranking
 * snapshot, not a per-line breakdown. `lines` is therefore a required field on this DTO, not
 * optional — the same lines originally submitted to `/matching/find`.
 */
export class SelectMatchDto {
  @IsOptional()
  @IsUUID()
  pharmacyId?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => OrderLineDto)
  lines!: OrderLineDto[];
}

/** `POST /matching/:id/rematch` (module-05 §5.5) — same `lines` deviation as `SelectMatchDto`. */
export class RematchDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => OrderLineDto)
  lines!: OrderLineDto[];
}
