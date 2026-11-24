import { Transform } from 'class-transformer';
import { IsOptional, IsString, IsUUID, IsUrl, Length } from 'class-validator';
import { SUSPEND_REASON_MAX, SUSPEND_REASON_MIN } from '../../application/commands/suspend-pharmacy.command';

/** `POST /pharmacy/suspend` (Work 153): the reason is audited and shown in the pharmacy's record. */
export class SuspendPharmacyDto {
  @IsUUID()
  pharmacyId!: string;

  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @Length(SUSPEND_REASON_MIN, SUSPEND_REASON_MAX)
  reason!: string;
}

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
