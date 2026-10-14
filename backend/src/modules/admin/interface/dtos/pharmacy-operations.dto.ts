import { Transform } from 'class-transformer';
import { IsDateString, IsEnum, IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import { TransactingStatus } from '../../../pharmacy-inventory/application/ports/inbound/pharmacy-operations-read.port';
import { MAX_PHARMACY_OPERATIONS_PAGE_SIZE } from '../../application/queries/pharmacy-operations.queries';

/**
 * `GET /admin/operations/pharmacies` query string: a stored status, two of Module 04's rules, and a
 * created window. No free-text search, no name/owner/contact/address filter.
 */
export class ListPharmacyOperationsQueryDto {
  /** Module 04's own `TransactingStatus` (the stored value, not eligibility). */
  @IsEnum(TransactingStatus)
  @IsOptional()
  transactingStatus?: TransactingStatus;

  /** `true` / `false` — `TransactingEligibilityPolicy` passes now. Raw string, as `isCod`. */
  @Transform(({ obj }) => (obj as Record<string, unknown>).eligible)
  @IsIn(['true', 'false'])
  @IsOptional()
  eligible?: 'true' | 'false';

  /** `true` / `false` — at least one listing is customer-purchasable now (Work 26's rule). */
  @Transform(({ obj }) => (obj as Record<string, unknown>).hasPurchasableInventory)
  @IsIn(['true', 'false'])
  @IsOptional()
  hasPurchasableInventory?: 'true' | 'false';

  @IsDateString()
  @IsOptional()
  createdFrom?: string;

  @IsDateString()
  @IsOptional()
  createdTo?: string;

  @IsInt()
  @Min(1)
  @IsOptional()
  page?: number;

  @IsInt()
  @Min(1)
  @Max(MAX_PHARMACY_OPERATIONS_PAGE_SIZE)
  @IsOptional()
  size?: number;
}
