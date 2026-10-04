import { IsEnum, IsInt, IsOptional, Max, Min } from 'class-validator';
import { DeliveryJobStatus } from '../../domain/enums';
import { MAX_DRIVER_JOB_PAGE_SIZE } from '../../application/queries/list-driver-jobs.query';

/**
 * Query parameters for `GET /delivery/jobs` (§9.2).
 *
 * **There is deliberately no `driverId` field.** The driver is the authenticated user and nothing
 * else, so there is no parameter through which a caller could widen the result to somebody else's
 * jobs — and because the global `ValidationPipe` runs with `forbidNonWhitelisted`, a request that
 * sends one is rejected outright rather than having it quietly dropped. That is the difference
 * between a field that is ignored and a field that does not exist: the first is one refactor away
 * from being honoured.
 *
 * `status` is validated against the whole `DeliveryJobStatus` enum here, and against the much
 * narrower driver-visible allow-list in `ListDriverJobsQuery`. Two layers, because this one only
 * proves the value is a delivery status at all; the query is what decides whether a driver may ask
 * about it.
 */
export class ListDriverJobsQueryDto {
  @IsEnum(DeliveryJobStatus)
  @IsOptional()
  status?: DeliveryJobStatus;

  @IsInt()
  @Min(1)
  @IsOptional()
  page?: number;

  @IsInt()
  @Min(1)
  @Max(MAX_DRIVER_JOB_PAGE_SIZE)
  @IsOptional()
  size?: number;
}
