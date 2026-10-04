import { IsEnum, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import {
  AccountStatus,
  PrimaryRole,
} from '../../../identity/application/ports/inbound/identity-admin.port';
import { MAX_USER_PAGE_SIZE } from '../../application/queries/list-users.query';

/** Same floor Module 01's own `SuspendUserDto` applies; the ceiling matches the verification reasons. */
export const MIN_ACCOUNT_REASON_LENGTH = 3;
export const MAX_ACCOUNT_REASON_LENGTH = 500;

/** `GET /admin/users` query string. Every filter is one Module 01 can answer. */
export class ListUsersQueryDto {
  @IsEnum(AccountStatus)
  @IsOptional()
  status?: AccountStatus;

  @IsEnum(PrimaryRole)
  @IsOptional()
  primaryRole?: PrimaryRole;

  /** Exact phone (E.164) or email. Bounded so it cannot be used as a payload. */
  @IsString()
  @MinLength(3)
  @MaxLength(254)
  @IsOptional()
  identifier?: string;

  @IsInt()
  @Min(1)
  @IsOptional()
  page?: number;

  @IsInt()
  @Min(1)
  @Max(MAX_USER_PAGE_SIZE)
  @IsOptional()
  size?: number;
}

/**
 * `POST /admin/users/:id/suspend`. **No actor field**: the administrator is the authenticated
 * principal, and `forbidNonWhitelisted` rejects a body that names one.
 */
export class SuspendUserDto {
  @IsString()
  @MinLength(MIN_ACCOUNT_REASON_LENGTH)
  @MaxLength(MAX_ACCOUNT_REASON_LENGTH)
  reason!: string;
}

/** `POST /admin/users/:id/reinstate`. The reason is optional and audit-only. */
export class ReinstateUserDto {
  @IsString()
  @MinLength(MIN_ACCOUNT_REASON_LENGTH)
  @MaxLength(MAX_ACCOUNT_REASON_LENGTH)
  @IsOptional()
  reason?: string;
}
