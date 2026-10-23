import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import { MAX_DECLINE_RECOVERY_PAGE_SIZE } from '../../application/queries/order-decline-recovery.queries';

/** `GET /admin/operations/order-decline-recovery` query string. */
export class ListOrderDeclineRecoveryQueryDto {
  @IsIn(['PENDING_CONFIRMATION', 'CONFIRMATION_FAILED', 'ORPHANED', 'RESOLVED'])
  @IsOptional()
  state?: 'PENDING_CONFIRMATION' | 'CONFIRMATION_FAILED' | 'ORPHANED' | 'RESOLVED';

  @IsInt()
  @Min(1)
  @IsOptional()
  page?: number;

  @IsInt()
  @Min(1)
  @Max(MAX_DECLINE_RECOVERY_PAGE_SIZE)
  @IsOptional()
  size?: number;
}
