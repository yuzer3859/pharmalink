import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { VerificationType } from '../../domain/enums';

export class SubmitFaydaDto {
  @IsString()
  @MinLength(12)
  @MaxLength(20)
  faydaId!: string;

  @IsBoolean()
  consentGranted!: boolean;

  @IsOptional()
  @IsString()
  fullName?: string;

  @IsOptional()
  @IsDateString()
  dateOfBirth?: string;

  @IsOptional()
  @IsUUID()
  organizationId?: string;
}

export class VerificationDocumentDto {
  @IsString()
  @MaxLength(64)
  kind!: string;

  @IsString()
  @MaxLength(512)
  storageRef!: string;

  @IsOptional()
  @IsDateString()
  expiresAt?: string;
}

export class SubmitDocumentsDto {
  @IsEnum(VerificationType)
  type!: VerificationType;

  @IsOptional()
  @IsUUID()
  organizationId?: string;

  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => VerificationDocumentDto)
  documents!: VerificationDocumentDto[];
}

export class ApproveVerificationDto {
  /** Licence expiry, when the approved document carries one. */
  @IsOptional()
  @IsDateString()
  expiresAt?: string;
}

export class RejectVerificationDto {
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;
}
