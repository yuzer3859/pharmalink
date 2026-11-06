import { DisputePriority, DisputeStatus, DisputeType } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsBoolean, IsEnum, IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength } from 'class-validator';

const MAX = 2000;

/** A customer's complaint about their own order (Work 86). */
export class OpenDisputeDto {
  @IsUUID()
  orderId!: string;

  @IsEnum(DisputeType)
  type!: DisputeType;

  @IsString()
  @MinLength(3)
  @MaxLength(200)
  subject!: string;

  @IsString()
  @MinLength(10)
  @MaxLength(MAX)
  description!: string;
}

/** An administrator opening a case on a customer's behalf may also set the priority. */
export class AdminOpenDisputeDto extends OpenDisputeDto {
  @IsEnum(DisputePriority)
  @IsOptional()
  priority?: DisputePriority;
}

export class DisputeMessageDto {
  @IsString()
  @MinLength(1)
  @MaxLength(MAX)
  body!: string;
}

export class AdminDisputeMessageDto extends DisputeMessageDto {
  /** Visible to administrators only. */
  @IsBoolean()
  @IsOptional()
  internal?: boolean;
}

export class UpdateDisputeDto {
  @IsEnum(DisputeStatus)
  @IsOptional()
  status?: DisputeStatus;

  @IsEnum(DisputePriority)
  @IsOptional()
  priority?: DisputePriority;

  /** `true` assigns the case to the caller; `false` unassigns it. */
  @IsBoolean()
  @IsOptional()
  assignToMe?: boolean;

  @IsString()
  @MaxLength(500)
  @IsOptional()
  reason?: string;
}

export class ResolveDisputeDto {
  @IsIn(['NO_ACTION', 'REFUND'])
  action!: 'NO_ACTION' | 'REFUND';

  @IsString()
  @MinLength(3)
  @MaxLength(MAX)
  notes!: string;

  /** Santim; omitted = everything still refundable. REFUND only. */
  @IsInt()
  @Min(1)
  @Max(2_147_483_647)
  @IsOptional()
  amount?: number;

  @IsIn(['ORIGINAL', 'WALLET'])
  @IsOptional()
  destination?: 'ORIGINAL' | 'WALLET';
}

export class ListDisputesDto {
  @IsEnum(DisputeStatus)
  @IsOptional()
  status?: DisputeStatus;

  @IsEnum(DisputeType)
  @IsOptional()
  type?: DisputeType;

  @IsEnum(DisputePriority)
  @IsOptional()
  priority?: DisputePriority;

  @Transform(({ obj }) => (obj as Record<string, unknown>).mine)
  @IsIn(['true', 'false'])
  @IsOptional()
  mine?: 'true' | 'false';

  @Transform(({ obj }) => (obj as Record<string, unknown>).overdue)
  @IsIn(['true', 'false'])
  @IsOptional()
  overdue?: 'true' | 'false';

  @IsUUID()
  @IsOptional()
  orderId?: string;

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
