import { Type } from 'class-transformer';
import { IsString, Length, Matches, ValidateNested } from 'class-validator';
import { DeviceInfoDto } from './device-info.dto';

/**
 * Administrator MFA request bodies (Work 66). The challenge token is the only proof of who is
 * signing in: no body accepts a user id. Every field is strictly shaped, and the global
 * ValidationPipe (`whitelist`, `forbidNonWhitelisted`) rejects anything else.
 */

/** 32 random bytes, base64url: exactly 43 characters. */
const CHALLENGE_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const TOTP_CODE = /^\d{6}$/;

export class MfaChallengeDto {
  @IsString()
  @Matches(CHALLENGE_TOKEN, { message: 'challengeToken is not a valid challenge token' })
  challengeToken!: string;
}

export class ConfirmMfaEnrollmentDto extends MfaChallengeDto {
  @IsString()
  @Matches(TOTP_CODE, { message: 'code must be six digits' })
  code!: string;

  @ValidateNested()
  @Type(() => DeviceInfoDto)
  deviceInfo!: DeviceInfoDto;
}

export class VerifyMfaChallengeDto extends ConfirmMfaEnrollmentDto {}

export class RedeemMfaRecoveryCodeDto extends MfaChallengeDto {
  /** `ABCD-EFGH-IJKL-MNOP`; case, spaces and dashes are ignored. */
  @IsString()
  @Length(16, 24)
  @Matches(/^[A-Za-z2-7 -]+$/, { message: 'recoveryCode is not a valid recovery code' })
  recoveryCode!: string;
}

export class RotateMfaRecoveryCodesDto {
  @IsString()
  @Matches(TOTP_CODE, { message: 'code must be six digits' })
  code!: string;
}
