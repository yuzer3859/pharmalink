import { PartialType } from '@nestjs/mapped-types';
import {
  IsBoolean,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
} from 'class-validator';

/**
 * POST /addresses (module-02 §4.2). `beneficiaryId` is intentionally absent — beneficiaries
 * don't exist yet (out of scope, §1.2) — so `forbidNonWhitelisted` (global pipe) rejects any
 * client attempt to set it with `422 VALIDATION_ERROR` (edge case 14). Phone-format validation
 * happens in the application layer via the `PhoneNumber` value object, not here, mirroring
 * Identity's own DTOs.
 */
export class CreateAddressDto {
  @IsOptional()
  @IsIn(['HOME', 'WORK', 'OTHER'])
  label?: string;

  @IsString()
  @Length(2, 120)
  recipientName!: string;

  @IsString()
  recipientPhone!: string;

  @IsOptional()
  @IsString()
  @Length(1, 100)
  region?: string;

  @IsOptional()
  @IsString()
  @Length(1, 100)
  city?: string;

  @IsOptional()
  @IsString()
  @Length(1, 100)
  subcity?: string;

  @IsOptional()
  @IsString()
  @Length(1, 100)
  woreda?: string;

  @IsOptional()
  @IsString()
  @Length(1, 200)
  landmark?: string;

  @IsOptional()
  @IsString()
  @Length(1, 300)
  addressLine?: string;

  @IsNumber()
  @Min(-90)
  @Max(90)
  lat!: number;

  @IsNumber()
  @Min(-180)
  @Max(180)
  lng!: number;

  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;
}

/** PATCH /addresses/:id — all fields optional (PATCH semantics), §4.2. */
export class UpdateAddressDto extends PartialType(CreateAddressDto) {}
