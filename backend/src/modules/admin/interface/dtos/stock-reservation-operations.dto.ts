import { Transform } from 'class-transformer';
import { IsDateString, IsEnum, IsIn, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { ReservationStatus } from '../../../pharmacy-inventory/application/ports/inbound/stock-reservation-operations-read.port';
import { MAX_RESERVATION_PAGE_SIZE } from '../../application/queries/stock-reservation-operations.queries';

/**
 * `GET /admin/operations/inventory/reservations` query string: the reservation's listing and that
 * listing's fixed owner, the stored status, the TTL sweeper's lapsed-hold rule, and a created window.
 * No order, customer or idempotency-key filter.
 */
export class ListStockReservationOperationsQueryDto {
  @IsUUID()
  @IsOptional()
  listingId?: string;

  @IsUUID()
  @IsOptional()
  pharmacyId?: string;

  @IsUUID()
  @IsOptional()
  branchId?: string;

  /** Module 04's own `ReservationStatus`. */
  @IsEnum(ReservationStatus)
  @IsOptional()
  status?: ReservationStatus;

  /** `true` / `false` — `HELD` and `expiresAt < generatedAt` (the sweeper's rule). Raw string, as `isCod`. */
  @Transform(({ obj }) => (obj as Record<string, unknown>).heldPastExpiry)
  @IsIn(['true', 'false'])
  @IsOptional()
  heldPastExpiry?: 'true' | 'false';

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
  @Max(MAX_RESERVATION_PAGE_SIZE)
  @IsOptional()
  size?: number;
}
