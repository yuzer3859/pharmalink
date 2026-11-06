import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
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
  /** Licence expiry, when the approved document carries one. Required for PHARMACY_LICENSE. */
  @IsOptional()
  @IsDateString()
  expiresAt?: string;

  /**
   * Approved licence number. Required for PHARMACY_LICENSE (Work 67), where it is trimmed and must
   * be 1 to 64 characters; not used for other types.
   */
  @IsOptional()
  @IsString()
  @MaxLength(256)
  licenseNumber?: string;
}

export class RejectVerificationDto {
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;
}

/** `POST /verification/documents/uploads` (Work 89): what will be uploaded. Checked by the command. */
export class RequestDocumentUploadDto {
  @IsString()
  @MaxLength(100)
  contentType!: string;

  @IsInt()
  bytes!: number;
}
