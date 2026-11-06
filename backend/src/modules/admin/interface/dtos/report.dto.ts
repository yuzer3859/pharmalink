import { IsEnum, IsInt, IsOptional, Matches, Max, Min } from 'class-validator';
import { ReportType } from '@prisma/client';

/** `POST /admin/reports` (Work 90). Inclusive UTC dates; the service bounds the window. */
export class RequestReportDto {
  @IsEnum(ReportType)
  type!: ReportType;

  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'from must be a date (YYYY-MM-DD)' })
  from!: string;

  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'to must be a date (YYYY-MM-DD)' })
  to!: string;
}

export class ListReportsQueryDto {
  @IsInt()
  @Min(1)
  @IsOptional()
  page?: number;

  @IsInt()
  @Min(1)
  @Max(100)
  @IsOptional()
  size?: number;
}
