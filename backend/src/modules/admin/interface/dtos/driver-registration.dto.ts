import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsIn,
  IsInt,
  IsLatitude,
  IsLongitude,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { ALLOWED_DOCUMENT_CONTENT_TYPES } from '../../../../shared/storage/document-storage.port';

export const DRIVER_DOCUMENT_KINDS = ['DRIVING_LICENSE', 'VEHICLE_REGISTRATION', 'NATIONAL_ID', 'INSURANCE', 'OTHER'] as const;
export const DRIVER_VEHICLE_TYPES = ['MOTORCYCLE', 'BICYCLE', 'CAR', 'VAN', 'ON_FOOT'] as const;

/** `POST /admin/drivers/uploads` (Work 156): one document, stored under the person. */
export class RequestDriverUploadDto {
  @IsUUID()
  userId!: string;

  @IsIn([...ALLOWED_DOCUMENT_CONTENT_TYPES])
  contentType!: string;

  @IsInt()
  @Min(1)
  @Max(10 * 1024 * 1024)
  bytes!: number;
}

export class DriverDocumentDto {
  @IsIn([...DRIVER_DOCUMENT_KINDS])
  kind!: string;

  @IsString()
  @MaxLength(512)
  @Matches(/^doc:/, { message: 'storageRef must be an uploaded file.' })
  storageRef!: string;
}

export class ServiceAreaDto {
  @IsLatitude()
  lat!: number;

  @IsLongitude()
  lng!: number;

  @IsInt()
  @Min(500)
  @Max(50_000)
  radiusMeters!: number;
}

/** `POST /admin/drivers` (Work 156). */
export class RegisterDriverDto {
  @IsUUID()
  userId!: string;

  @IsIn([...DRIVER_VEHICLE_TYPES])
  vehicleType!: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  plateNumber?: string;

  /** `YYYY-MM-DD`: the earliest expiry among the documents. */
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  documentsExpireOn!: string;

  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => DriverDocumentDto)
  documents!: DriverDocumentDto[];

  @IsOptional()
  @ValidateNested()
  @Type(() => ServiceAreaDto)
  serviceArea?: ServiceAreaDto;
}
