import { Type } from 'class-transformer';
import { IsIn, IsInt, IsISO8601, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength } from 'class-validator';

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

export class ReleaseRxRequestDto {
  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason?: string;
}
