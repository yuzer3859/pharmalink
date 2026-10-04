import { Type } from 'class-transformer';
import {
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  Min,
} from 'class-validator';
import { PrescriptionStatus } from '../../domain/enums';

const FILE_TYPES = ['image/jpeg', 'image/png', 'application/pdf'] as const;

/** `POST /prescriptions` (module-05 §5.1). */
export class UploadPrescriptionDto {
  @IsString()
  @Length(1, 500)
  fileRef!: string;

  @IsOptional()
  @IsString()
  @Length(1, 500)
  encryptionKeyRef?: string;

  @IsIn(FILE_TYPES)
  fileType!: string;

  @IsOptional()
  @IsUUID()
  beneficiaryId?: string;

  @IsOptional()
  @IsString()
  @Length(1, 200)
  doctorName?: string;

  @IsOptional()
  @IsString()
  @Length(1, 200)
  hospitalName?: string;

  @IsOptional()
  @IsDateString()
  issueDate?: string;

  @IsOptional()
  @IsDateString()
  expiryDate?: string;
}

/** `POST /prescriptions/:id/reupload` (module-05 §10.1) — "same shape as §5.1's file fields". */
export class ReuploadPrescriptionDto {
  @IsString()
  @Length(1, 500)
  fileRef!: string;

  @IsOptional()
  @IsString()
  @Length(1, 500)
  encryptionKeyRef?: string;

  @IsIn(FILE_TYPES)
  fileType!: string;
}

/** `GET /prescriptions` (module-05 §10.1) — same page/size pagination convention as Module 04's `ListListingsQueryDto`. */
export class ListPrescriptionsQueryDto {
  @IsOptional()
  @IsIn(Object.values(PrescriptionStatus))
  status?: PrescriptionStatus;

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
