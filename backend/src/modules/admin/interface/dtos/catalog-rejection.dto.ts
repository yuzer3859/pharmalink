import { Transform } from 'class-transformer';
import { IsString, MaxLength, MinLength } from 'class-validator';
import {
  REJECTION_REASON_MAX_LENGTH,
  REJECTION_REASON_MIN_LENGTH,
} from '../../../catalog/application/ports/inbound/catalog-review-rejection.port';

/**
 * `POST /admin/catalog/review/:productId/reject` (module-16 Work 31). The reason is required —
 * trimmed, then 3–300 characters, Module 03's own limits (which its status command enforces again,
 * so no path can reject without one). A blank or whitespace-only reason is refused. No reviewer or
 * status field: the reviewer is the token's principal, and `forbidNonWhitelisted` rejects extras.
 */
export class RejectCatalogProductDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(REJECTION_REASON_MIN_LENGTH)
  @MaxLength(REJECTION_REASON_MAX_LENGTH)
  reason!: string;
}
