import { Transform } from 'class-transformer';
import { IsEnum, IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import { DriverAvailability } from '../../../delivery/application/ports/inbound/driver-operations-read.port';
import { MAX_DRIVER_OPERATIONS_PAGE_SIZE } from '../../application/queries/driver-operations.queries';

/**
 * `GET /admin/operations/drivers` query string. Both filters are columns of `driver_profiles`;
 * there is no free-text search and no filter on any personal, vehicle or location field.
 */
export class ListDriverOperationsQueryDto {
  /** Module 08's own `DriverAvailability`. */
  @IsEnum(DriverAvailability)
  @IsOptional()
  availability?: DriverAvailability;

  /** `true` / `false`. Kept as the raw string: implicit conversion would read `"false"` as `true`. */
  @Transform(({ obj }) => (obj as Record<string, unknown>).onShift)
  @IsIn(['true', 'false'])
  @IsOptional()
  onShift?: 'true' | 'false';

  @IsInt()
  @Min(1)
  @IsOptional()
  page?: number;

  @IsInt()
  @Min(1)
  @Max(MAX_DRIVER_OPERATIONS_PAGE_SIZE)
  @IsOptional()
  size?: number;
}
