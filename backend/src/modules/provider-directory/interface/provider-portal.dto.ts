import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  IsLatitude,
  IsLongitude,
  IsOptional,
  IsString,
  IsUrl,
  IsUUID,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

export const EMERGENCY_AVAILABILITY = ['NONE', 'BUSINESS_HOURS', 'H24_7'] as const;
export const SERVICE_TYPES = ['LAB_TEST', 'IMAGING', 'SCREENING_PACKAGE'] as const;
const PHONE = /^\+?[0-9 ()-]{7,20}$/;
const TIME = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

/** `PATCH /provider/profile` (Work 161). The name customers see is changed by an administrator. */
export class UpdateProviderProfileDto {
  @IsOptional() @IsString() @MaxLength(200) nameEn?: string;
  @IsOptional() @IsString() @MaxLength(200) nameAm?: string;
  @IsOptional() @IsString() @MaxLength(2000) description?: string;
  @IsOptional() @IsUrl({ require_protocol: true, protocols: ['https', 'http'] }) @MaxLength(300) website?: string;
  @IsOptional() @Matches(PHONE) contactPhone?: string;
  @IsOptional() @IsEmail() @MaxLength(254) contactEmail?: string;
}

/** `POST /provider/locations` (Work 161). Every location has its map position (module-09 §5.3). */
export class CreateLocationDto {
  @IsString() @Length(2, 120) name!: string;
  @IsOptional() @IsString() @MaxLength(80) region?: string;
  @IsString() @Length(2, 80) city!: string;
  @IsOptional() @IsString() @MaxLength(80) subcity?: string;
  @IsOptional() @IsString() @MaxLength(40) woreda?: string;
  @IsOptional() @IsString() @MaxLength(200) addressLine?: string;
  @Type(() => Number) @IsLatitude() lat!: number;
  @Type(() => Number) @IsLongitude() lng!: number;
  @IsOptional() @Matches(PHONE) phone?: string;
  @IsOptional() @IsIn([...EMERGENCY_AVAILABILITY]) emergencyAvailability?: (typeof EMERGENCY_AVAILABILITY)[number];
  @IsOptional() @IsBoolean() isPrimary?: boolean;
}

/** `PATCH /provider/locations/:id` (Work 161). */
export class UpdateLocationDto {
  @IsOptional() @IsString() @Length(2, 120) name?: string;
  @IsOptional() @IsString() @MaxLength(80) region?: string;
  @IsOptional() @IsString() @Length(2, 80) city?: string;
  @IsOptional() @IsString() @MaxLength(80) subcity?: string;
  @IsOptional() @IsString() @MaxLength(40) woreda?: string;
  @IsOptional() @IsString() @MaxLength(200) addressLine?: string;
  @IsOptional() @Type(() => Number) @IsLatitude() lat?: number;
  @IsOptional() @Type(() => Number) @IsLongitude() lng?: number;
  @IsOptional() @Matches(PHONE) phone?: string;
  @IsOptional() @IsIn([...EMERGENCY_AVAILABILITY]) emergencyAvailability?: (typeof EMERGENCY_AVAILABILITY)[number];
  @IsOptional() @IsBoolean() isPrimary?: boolean;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

export class OperatingHourDto {
  /** 0 = Sunday … 6 = Saturday. */
  @IsInt() @Min(0) @Max(6) weekday!: number;
  @IsOptional() @Matches(TIME) openTime?: string;
  @IsOptional() @Matches(TIME) closeTime?: string;
  @IsOptional() @IsBoolean() isClosed?: boolean;
}

/** `PUT /provider/locations/:id/hours` (Work 161): the whole week, replacing what was there. */
export class SetOperatingHoursDto {
  @IsArray()
  @ArrayMaxSize(7)
  @ValidateNested({ each: true })
  @Type(() => OperatingHourDto)
  hours!: OperatingHourDto[];
}

/** `PUT /provider/locations/:id/facilities` (Work 161): e.g. parking, ambulance, wheelchair access. */
export class SetFacilitiesDto {
  @IsArray()
  @ArrayMaxSize(30)
  @ArrayUnique()
  @IsString({ each: true })
  @Length(2, 60, { each: true })
  facilities!: string[];
}

/** `POST /provider/departments` (Work 161). */
export class CreateDepartmentDto {
  @IsString() @Length(2, 120) name!: string;
  @IsOptional() @IsString() @MaxLength(120) specialty?: string;
  @IsOptional() @IsString() @MaxLength(1000) description?: string;
  @IsOptional() @Matches(PHONE) contactPhone?: string;
}

/** `PATCH /provider/departments/:id` (Work 161). */
export class UpdateDepartmentDto {
  @IsOptional() @IsString() @Length(2, 120) name?: string;
  @IsOptional() @IsString() @MaxLength(120) specialty?: string;
  @IsOptional() @IsString() @MaxLength(1000) description?: string;
  @IsOptional() @Matches(PHONE) contactPhone?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

/** `POST /provider/services` (Work 161): a lab test, imaging study or screening package. */
export class CreateServiceDto {
  @IsIn([...SERVICE_TYPES]) type!: (typeof SERVICE_TYPES)[number];
  @IsString() @Length(2, 160) name!: string;
  @IsOptional() @IsString() @MaxLength(40) code?: string;
  @IsOptional() @IsString() @MaxLength(2000) description?: string;
  /** Estimated price in santim (1 ETB = 100), when known (module-09 F-SVC-02). */
  @IsOptional() @IsInt() @Min(0) @Max(100_000_000) price?: number;
  @IsOptional() @IsInt() @Min(1) @Max(24 * 60) durationMinutes?: number;
  @IsOptional() @IsString() @MaxLength(2000) preparationInstructions?: string;
  /** The location offering it; any of the provider's locations when omitted. */
  @IsOptional() @IsUUID() locationId?: string;
  @IsOptional() @IsBoolean() isAvailable?: boolean;
}

/** `PATCH /provider/services/:id` (Work 161). */
export class UpdateServiceDto {
  @IsOptional() @IsIn([...SERVICE_TYPES]) type?: (typeof SERVICE_TYPES)[number];
  @IsOptional() @IsString() @Length(2, 160) name?: string;
  @IsOptional() @IsString() @MaxLength(40) code?: string;
  @IsOptional() @IsString() @MaxLength(2000) description?: string;
  @IsOptional() @IsInt() @Min(0) @Max(100_000_000) price?: number;
  @IsOptional() @IsInt() @Min(1) @Max(24 * 60) durationMinutes?: number;
  @IsOptional() @IsString() @MaxLength(2000) preparationInstructions?: string;
  @IsOptional() @IsUUID() locationId?: string;
  @IsOptional() @IsBoolean() isAvailable?: boolean;
}
