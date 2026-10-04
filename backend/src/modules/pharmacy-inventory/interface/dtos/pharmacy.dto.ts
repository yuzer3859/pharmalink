import { IsOptional, IsString, IsUUID, IsUrl, Length } from 'class-validator';

/** `POST /pharmacy/register` (module-04 §5.1). */
export class RegisterPharmacyDto {
  @IsUUID()
  organizationId!: string;

  @IsString()
  @Length(2, 200)
  displayName!: string;

  @IsOptional()
  @IsUrl()
  logoUrl?: string;

  @IsOptional()
  @IsString()
  @Length(0, 2000)
  description?: string;
}

/** `PATCH /pharmacy/profile` (module-04 §5.1). */
export class UpdatePharmacyProfileDto {
  @IsOptional()
  @IsString()
  @Length(2, 200)
  displayName?: string;

  @IsOptional()
  @IsUrl()
  logoUrl?: string;

  @IsOptional()
  @IsString()
  @Length(0, 2000)
  description?: string;
}

/** `POST /pharmacy/activate` (module-04 §4, §10.1). */
export class ActivatePharmacyDto {
  @IsUUID()
  pharmacyId!: string;
}
