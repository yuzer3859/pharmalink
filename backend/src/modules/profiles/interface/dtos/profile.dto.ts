import { IsIn, IsISO8601, IsOptional, IsString, Length } from 'class-validator';
import { IANA_TZ_ALLOWLIST } from '../../domain/enums';

/**
 * PATCH /profile/me (module-02 §4.1). All fields optional (PATCH semantics); the "at least one
 * field required" and `dateOfBirth` business rules are enforced in `UpdateProfileCommand`
 * because they depend on cross-field state / "now".
 */
export class UpdateProfileDto {
  @IsOptional()
  @IsString()
  @Length(2, 120)
  fullName?: string;

  @IsOptional()
  @IsIn(['MALE', 'FEMALE', 'OTHER', 'UNKNOWN'])
  gender?: string;

  @IsOptional()
  @IsISO8601()
  dateOfBirth?: string;

  @IsOptional()
  @IsString()
  secondaryPhone?: string;

  @IsOptional()
  @IsString()
  @Length(1, 64)
  @IsIn(IANA_TZ_ALLOWLIST)
  timezone?: string;
}
