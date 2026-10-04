import {
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import {
  VerificationStatus,
  VerificationType,
} from '../../../identity/application/ports/inbound/identity-admin.port';
import { MAX_VERIFICATION_PAGE_SIZE } from '../../application/queries/list-verification-queue.query';

/**
 * Bounds on a decision reason — the same 3..500 Module 01's `RejectVerificationDto` applies, so
 * a reason accepted here is one Module 01 will accept when it is forwarded.
 */
export const MIN_VERIFICATION_REASON_LENGTH = 3;
export const MAX_VERIFICATION_REASON_LENGTH = 500;

/**
 * `GET /admin/verifications` query string. Every filter is a column Module 01 stores; `page` and
 * `size` are validated here and clamped again in the query, so the two never disagree.
 */
export class ListVerificationsQueryDto {
  @IsEnum(VerificationStatus)
  @IsOptional()
  status?: VerificationStatus;

  @IsEnum(VerificationType)
  @IsOptional()
  type?: VerificationType;

  @IsUUID()
  @IsOptional()
  userId?: string;

  @IsUUID()
  @IsOptional()
  organizationId?: string;

  @IsDateString()
  @IsOptional()
  submittedFrom?: string;

  @IsDateString()
  @IsOptional()
  submittedTo?: string;

  @IsInt()
  @Min(1)
  @IsOptional()
  page?: number;

  @IsInt()
  @Min(1)
  @Max(MAX_VERIFICATION_PAGE_SIZE)
  @IsOptional()
  size?: number;
}

/**
 * `POST /admin/verifications/:id/approve`.
 *
 * **There is no reviewer or actor field.** The reviewer is the authenticated principal, and with
 * `forbidNonWhitelisted` on the global pipe a body that names one is rejected rather than ignored
 * — the same discipline `UpdateConfigDto` documents.
 */
export class ApproveVerificationDto {
  /** Licence expiry, when the approved document carries one — forwarded to Module 01. */
  @IsDateString()
  @IsOptional()
  expiresAt?: string;

  /** Reviewer's note, recorded in this module's audit entry. */
  @IsString()
  @MaxLength(MAX_VERIFICATION_REASON_LENGTH)
  @IsOptional()
  reason?: string;
}

/** `POST /admin/verifications/:id/reject`. The reason is required — Module 01 will not decide without one. */
export class RejectVerificationDto {
  @IsString()
  @MinLength(MIN_VERIFICATION_REASON_LENGTH)
  @MaxLength(MAX_VERIFICATION_REASON_LENGTH)
  reason!: string;
}
