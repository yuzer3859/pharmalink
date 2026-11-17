import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { PREPAID_METHODS, PrepaidMethod } from '../../application/commands/checkout.command';

/** Work 134: the customer sends an uploaded prescription to nearby pharmacies. */
export class CreateRxRequestDto {
  @IsUUID()
  prescriptionId!: string;

  @IsUUID()
  addressId!: string;

  /** The date on the prescription (`YYYY-MM-DD`). */
  @IsISO8601({ strict: true })
  prescriptionIssueDate!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class RxRequestPageDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  size?: number;
}

export class PharmacyRxRequestListDto extends RxRequestPageDto {
  @IsOptional()
  @IsIn(['active', 'all'])
  scope?: 'active' | 'all';
}

/** A pharmacy that cannot fill the request says why (kept for operations, not shown to the customer). */
export class DeclineRxRequestDto {
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;
}

export class RxQuoteLineDto {
  @IsUUID()
  catalogProductId!: string;

  @IsInt()
  @Min(1)
  @Max(1000)
  quantity!: number;
}

/** Work 135: the holding pharmacy's quote. */
export class QuoteRxRequestDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(30)
  @ValidateNested({ each: true })
  @Type(() => RxQuoteLineDto)
  lines!: RxQuoteLineDto[];

  /** The date on the prescription as the pharmacist reads it (`YYYY-MM-DD`). */
  @IsISO8601({ strict: true })
  prescriptionIssueDate!: string;

  /** Omitted: required when a quoted medicine is a controlled substance. */
  @IsOptional()
  @IsBoolean()
  paperRequired?: boolean;

  @IsBoolean()
  legibilityOk!: boolean;

  @IsBoolean()
  validityOk!: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class RxConfirmPaymentDto {
  @IsIn(PREPAID_METHODS as unknown as string[])
  method!: PrepaidMethod;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  token?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2048)
  returnUrl?: string;
}

/**
 * Work 135: the customer accepts the quote. No payment: cash on delivery. No idempotency key is
 * needed: the order is keyed by the request, so a repeated confirmation finishes the same order.
 */
export class ConfirmRxRequestDto {
  @IsOptional()
  @ValidateNested()
  @Type(() => RxConfirmPaymentDto)
  payment?: RxConfirmPaymentDto;
}

export class ReleaseRxRequestDto {
  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason?: string;
}
