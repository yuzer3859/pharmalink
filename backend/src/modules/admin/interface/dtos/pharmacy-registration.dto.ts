import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsIn,
  IsInt,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { ALLOWED_DOCUMENT_CONTENT_TYPES } from '../../../../shared/storage/document-storage.port';

/** The licence files a registration may carry. */
export const LICENCE_DOCUMENT_KINDS = ['BUSINESS_LICENSE', 'PHARMACY_LICENSE', 'PHARMACIST_LICENSE', 'TAX_REGISTRATION', 'OTHER'] as const;

/** `POST /admin/pharmacy-registrations/uploads` (Work 154): one licence file, stored under the owner. */
export class RequestOwnerLicenceUploadDto {
  @IsUUID()
  ownerUserId!: string;

  @IsIn([...ALLOWED_DOCUMENT_CONTENT_TYPES])
  contentType!: string;

  @IsInt()
  @Min(1)
  @Max(10 * 1024 * 1024)
  bytes!: number;
}

export class LicenceDocumentDto {
  @IsIn([...LICENCE_DOCUMENT_KINDS])
  kind!: string;

  @IsString()
  @MaxLength(512)
  @Matches(/^doc:/, { message: 'storageRef must be an uploaded file.' })
  storageRef!: string;
}

/** `POST /admin/pharmacy-registrations` (Work 154). */
export class RegisterPharmacyForOwnerDto {
  @IsUUID()
  ownerUserId!: string;

  @IsString()
  @Length(2, 200)
  legalName!: string;

  @IsString()
  @Length(2, 200)
  displayName!: string;

  @IsString()
  @Length(1, 64)
  licenseNumber!: string;

  /** `YYYY-MM-DD`, the licence's last valid day. */
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  licenseExpiresOn!: string;

  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => LicenceDocumentDto)
  documents!: LicenceDocumentDto[];

  @IsUUID()
  idempotencyKey!: string;
}
