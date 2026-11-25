import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
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
import { PROVIDER_STATUSES, PROVIDER_TYPES } from '../../../provider-directory/domain/provider-rules';

/** The licence files a facility registration may carry. */
export const FACILITY_DOCUMENT_KINDS = ['BUSINESS_LICENSE', 'FACILITY_LICENSE', 'ACCREDITATION', 'TAX_REGISTRATION', 'OTHER'] as const;

/** `POST /admin/provider-registrations/uploads` (Work 160): one licence file, stored under the facility administrator. */
export class RequestFacilityLicenceUploadDto {
  @IsUUID()
  adminUserId!: string;

  @IsIn([...ALLOWED_DOCUMENT_CONTENT_TYPES])
  contentType!: string;

  @IsInt()
  @Min(1)
  @Max(10 * 1024 * 1024)
  bytes!: number;
}

export class FacilityLicenceDocumentDto {
  @IsIn([...FACILITY_DOCUMENT_KINDS])
  kind!: string;

  @IsString()
  @MaxLength(512)
  @Matches(/^doc:/, { message: 'storageRef must be an uploaded file.' })
  storageRef!: string;
}

/** `POST /admin/provider-registrations` (Work 160). */
export class RegisterProviderDto {
  @IsUUID()
  adminUserId!: string;

  @IsIn([...PROVIDER_TYPES])
  type!: (typeof PROVIDER_TYPES)[number];

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
  @Type(() => FacilityLicenceDocumentDto)
  documents!: FacilityLicenceDocumentDto[];

  @IsUUID()
  idempotencyKey!: string;
}

/** `GET /admin/providers` (Work 160). */
export class ListProvidersQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;

  @IsOptional()
  @IsIn([...PROVIDER_TYPES])
  type?: (typeof PROVIDER_TYPES)[number];

  @IsOptional()
  @IsIn([...PROVIDER_STATUSES])
  status?: (typeof PROVIDER_STATUSES)[number];

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  size?: number = 20;
}

/** `POST /admin/providers/:id/suspend` (Work 160). */
export class SuspendProviderDto {
  @IsString()
  @Length(3, 500)
  reason!: string;
}
