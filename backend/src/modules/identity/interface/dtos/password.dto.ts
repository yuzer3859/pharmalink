import { IsString, MaxLength, MinLength } from 'class-validator';

export class ForgotPasswordDto {
  @IsString()
  @MinLength(3)
  @MaxLength(255)
  identifier!: string;
}

export class ResetPasswordDto {
  @IsString()
  @MinLength(3)
  @MaxLength(255)
  identifier!: string;

  @IsString()
  @MinLength(4)
  @MaxLength(12)
  code!: string;

  /** Strength is enforced by PasswordPolicy in the domain; this is only a coarse guard. */
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  newPassword!: string;
}

export class ChangePasswordDto {
  @IsString()
  @MaxLength(128)
  oldPassword!: string;

  @IsString()
  @MinLength(8)
  @MaxLength(128)
  newPassword!: string;
}
