import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

/** One line of `POST /pharmacy/verification/:id/approve` (module-05 §5.2). */
export class ApproveLineDto {
  @IsOptional()
  @IsString()
  @Length(1, 500)
  rawText?: string;

  @IsUUID()
  catalogProductId!: string;

  @IsInt()
  @Min(1)
  approvedQuantity!: number;

  @IsInt()
  @Min(0)
  refillsAllowed!: number;

  @IsBoolean()
  isSingleUse!: boolean;
}

/** `POST /pharmacy/verification/:id/approve` (module-05 §5.2). */
export class ApprovePrescriptionDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ApproveLineDto)
  lines!: ApproveLineDto[];

  @IsBoolean()
  legibilityOk!: boolean;

  @IsBoolean()
  validityOk!: boolean;
}

/** `POST /pharmacy/verification/:id/reject` (module-05 §5.2) — mandatory reason, BRULE-14.
 * `RejectionReason` (domain VO) is the actual source of truth for the business rule; this DTO
 * only validates HTTP/input shape (a non-empty string in a reasonable length range). */
export class RejectPrescriptionDto {
  @IsString()
  @Length(3, 500)
  reason!: string;
}

/** `POST /pharmacy/verification/:id/clarify` (module-05 §5.2). */
export class RequestClarificationDto {
  @IsString()
  @Length(3, 500)
  message!: string;
}

/** `GET /pharmacy/verification/queue` (module-05 §10.2) — same pagination convention as `ListPrescriptionsQueryDto`. */
export class VerificationQueueQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  size?: number = 20;
}
