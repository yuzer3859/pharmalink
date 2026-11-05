import { PayoutRail } from '@prisma/client';
import { IsEnum, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { MAX_APPROVAL_REASON_LENGTH } from '../../domain/maker-checker/approval-request';

/** The maker's optional reason for a gated settlement action (Work 83). */
export class MakerCheckerReasonDto {
  @IsString()
  @MaxLength(MAX_APPROVAL_REASON_LENGTH)
  @IsOptional()
  reason?: string;
}

/**
 * A pharmacy's payout destination (Work 83). Format rules per rail are Module 07's
 * (`normaliseAccount`); this only bounds the shapes.
 */
export class RegisterPayoutBeneficiaryDto {
  @IsEnum(PayoutRail)
  rail!: PayoutRail;

  @IsString()
  @MinLength(2)
  @MaxLength(120)
  accountName!: string;

  @IsString()
  @MaxLength(20)
  @IsOptional()
  bankCode?: string;

  @IsString()
  @MinLength(6)
  @MaxLength(40)
  accountIdentifier!: string;
}
