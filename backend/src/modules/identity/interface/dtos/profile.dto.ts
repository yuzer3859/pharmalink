import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

export class UpdateProfileDto {
  @IsOptional()
  @IsIn(['am', 'en'])
  preferredLanguage?: 'am' | 'en';
}

/** Step-up confirmation for destructive self-service actions (module-01 §11.5). */
export class ConfirmPasswordDto {
  @IsString()
  @MaxLength(128)
  password!: string;
}

export class RequestDeletionDto extends ConfirmPasswordDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
