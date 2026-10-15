import { IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { MAX_INTEGRITY_PAGE_SIZE } from '../../application/queries/reservation-integrity.queries';

/** `GET /admin/operations/inventory/reservation-integrity/summary` scope: a listing's fixed owner. */
export class ReservationIntegrityScopeDto {
  @IsUUID()
  @IsOptional()
  pharmacyId?: string;

  @IsUUID()
  @IsOptional()
  branchId?: string;
}

/** `GET /admin/operations/inventory/reservation-integrity`: the same scope plus paging. */
export class ListReservationIntegrityQueryDto extends ReservationIntegrityScopeDto {
  @IsInt()
  @Min(1)
  @IsOptional()
  page?: number;

  @IsInt()
  @Min(1)
  @Max(MAX_INTEGRITY_PAGE_SIZE)
  @IsOptional()
  size?: number;
}
