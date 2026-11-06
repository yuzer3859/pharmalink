import { Transform } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength } from 'class-validator';

/** Work 85: why support needs to see the account as its holder. Required and audited. */
export class ImpersonationRequestDto {
  @IsString()
  @MinLength(5)
  @MaxLength(500)
  reason!: string;
}

export class ListImpersonationSessionsDto {
  /** `false` lists everyone's sessions; anything else (default) only the caller's. Raw string, as `isCod`. */
  @Transform(({ obj }) => (obj as Record<string, unknown>).mine)
  @IsIn(['true', 'false'])
  @IsOptional()
  mine?: 'true' | 'false';

  @IsUUID()
  @IsOptional()
  targetUserId?: string;

  @IsInt()
  @Min(1)
  @IsOptional()
  page?: number;

  @IsInt()
  @Min(1)
  @Max(100)
  @IsOptional()
  size?: number;
}
