import { IsDateString, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';
import { MAX_AUDIT_PAGE_SIZE } from '../../application/queries/list-audit.query';

/**
 * `GET /admin/audit` query string. Each filter is a column of `audit_logs` and is matched
 * exactly — there is no free-text, no pattern and no predicate over `context`, so nothing a
 * client sends becomes anything but a bound parameter.
 */
export class ListAuditQueryDto {
  @IsString()
  @MaxLength(128)
  @IsOptional()
  action?: string;

  @IsUUID()
  @IsOptional()
  actorUserId?: string;

  @IsString()
  @MaxLength(64)
  @IsOptional()
  resourceType?: string;

  /** Not constrained to a uuid: some writers use a natural key (a config path, an order number). */
  @IsString()
  @MaxLength(256)
  @IsOptional()
  resourceId?: string;

  @IsDateString()
  @IsOptional()
  from?: string;

  @IsDateString()
  @IsOptional()
  to?: string;

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
