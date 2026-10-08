import { IsDateString, IsEnum, IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import {
  SUPPRESSION_REASONS,
  SuppressionChannel,
} from '../../../notifications/application/ports/inbound/notification-suppression-admin.port';
import { MAX_SUPPRESSION_PAGE_SIZE } from '../../application/queries/list-suppressions.query';

/**
 * `GET /admin/notifications/suppressions` filters — stored columns only. There is deliberately no
 * address, hash or free-text filter: an operator cannot probe whether a destination is suppressed.
 */
export class ListSuppressionsQueryDto {
  @IsEnum(SuppressionChannel)
  @IsOptional()
  channel?: SuppressionChannel;

  @IsIn(SUPPRESSION_REASONS)
  @IsOptional()
  reason?: string;

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
  @Max(MAX_SUPPRESSION_PAGE_SIZE)
  @IsOptional()
  size?: number;
}
