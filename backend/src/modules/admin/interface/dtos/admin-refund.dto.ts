import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { MAX_APPROVAL_REASON_LENGTH } from '../../domain/maker-checker/approval-request';

/** `POST /admin/finance/payments/{id}/refunds` (Work 84). Amount in santim; omitted = everything refundable. */
export class AdminRefundDto {
  @IsInt()
  @Min(1)
  @Max(2_147_483_647)
  @IsOptional()
  amount?: number;

  @IsString()
  @MaxLength(MAX_APPROVAL_REASON_LENGTH)
  @IsOptional()
  reason?: string;

  @IsIn(['ORIGINAL', 'WALLET'])
  @IsOptional()
  destination?: 'ORIGINAL' | 'WALLET';
}
