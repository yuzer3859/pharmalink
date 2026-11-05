import { IsEnum, IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import { Transform } from 'class-transformer';
import {
  ApprovalDecision,
  ApprovalStatus,
  MAX_APPROVAL_REASON_LENGTH,
} from '../../domain/maker-checker/approval-request';
import { MAX_APPROVAL_PAGE_SIZE } from '../../application/maker-checker/approval-queries';

export class ListApprovalsQueryDto {
  @IsEnum(ApprovalStatus)
  @IsOptional()
  status?: ApprovalStatus;

  @IsString()
  @Matches(/^[A-Z][A-Z0-9_]{0,63}$/)
  @IsOptional()
  actionType?: string;

  /** `true` / `false` — only the caller's own requests. Raw string, as `isCod`. */
  @Transform(({ obj }) => (obj as Record<string, unknown>).mine)
  @IsIn(['true', 'false'])
  @IsOptional()
  mine?: 'true' | 'false';

  @IsInt()
  @Min(1)
  @IsOptional()
  page?: number;

  @IsInt()
  @Min(1)
  @Max(MAX_APPROVAL_PAGE_SIZE)
  @IsOptional()
  size?: number;
}

export class DecideApprovalDto {
  @IsEnum(ApprovalDecision)
  decision!: ApprovalDecision;

  /** Required to reject (checked in the command, which owns the rule). */
  @IsString()
  @MaxLength(MAX_APPROVAL_REASON_LENGTH)
  @IsOptional()
  reason?: string;
}
