import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';

/** `GET /admin/analytics/timeseries` (Work 87). Ranges and counts are checked by the service. */
export class AnalyticsTimeseriesQueryDto {
  /** Comma-separated metric keys from `GET /admin/analytics/metrics`, at most eight. */
  @IsString()
  @MaxLength(1000)
  @Matches(/^[A-Za-z0-9_.]+(,[A-Za-z0-9_.]+)*$/, { message: 'metrics must be comma-separated metric keys' })
  metrics!: string;

  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'from must be a date (YYYY-MM-DD)' })
  @IsOptional()
  from?: string;

  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'to must be a date (YYYY-MM-DD)' })
  @IsOptional()
  to?: string;
}
