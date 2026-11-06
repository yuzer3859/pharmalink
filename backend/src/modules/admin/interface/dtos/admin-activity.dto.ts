import { IsDateString, IsInt, IsOptional, Max, Min } from 'class-validator';
import { MAX_AUDIT_PAGE_SIZE } from '../../application/queries/list-audit.query';

/** `GET /admin/admins/activity` (Work 88). ISO timestamps; the service bounds the window. */
export class AdminActivityQueryDto {
  @IsDateString()
  @IsOptional()
  from?: string;

  @IsDateString()
  @IsOptional()
  to?: string;
}

/** `GET /admin/admins/activity/{userId}`. */
export class AdminActivityEntriesQueryDto extends AdminActivityQueryDto {
  @IsInt()
  @Min(1)
  @IsOptional()
  page?: number;

  @IsInt()
  @Min(1)
  @Max(MAX_AUDIT_PAGE_SIZE)
  @IsOptional()
  size?: number;
}
