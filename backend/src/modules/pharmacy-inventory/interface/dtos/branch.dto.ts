import { PartialType } from '@nestjs/mapped-types';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsInt,
  IsLatitude,
  IsLongitude,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

const PHONE_REGEX = /^\+?[0-9]{7,15}$/;

/** `POST /pharmacy/branches` (module-04 §5.2). */
export class CreateBranchDto {
  @IsString()
  @Length(2, 120)
  name!: string;

  @IsOptional()
  @IsString()
  region?: string;

  @IsOptional()
  @IsString()
  city?: string;

  @IsOptional()
  @IsString()
  subcity?: string;

  @IsOptional()
  @IsString()
  woreda?: string;

  @IsOptional()
  @IsString()
  @Length(0, 300)
  addressLine?: string;

  @IsOptional()
  @IsLatitude()
  lat?: number;

  @IsOptional()
  @IsLongitude()
  lng?: number;

  @IsOptional()
  @Matches(PHONE_REGEX)
  phone?: string;
}

/** `PATCH /pharmacy/branches/:id` (module-04 §5.2). */
export class UpdateBranchDto extends PartialType(CreateBranchDto) {
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class OperatingHourRowDto {
  @IsInt()
  @Min(0)
  @Max(6)
  weekday!: number;

  @IsOptional()
  @Matches(/^\d{2}:\d{2}$/)
  openTime?: string;

  @IsOptional()
  @Matches(/^\d{2}:\d{2}$/)
  closeTime?: string;

  @IsBoolean()
  isClosed!: boolean;
}

/** `PUT /pharmacy/branches/:id/hours` — full-week replace (module-04 §5.2). */
export class SetOperatingHoursDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => OperatingHourRowDto)
  hours!: OperatingHourRowDto[];
}
