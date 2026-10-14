import { Transform } from 'class-transformer';
import { IsDateString, IsIn, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { MAX_BRANCH_OPERATIONS_PAGE_SIZE } from '../../application/queries/branch-operations.queries';

/**
 * `GET /admin/operations/branches` query string: the owning pharmacy, the stored active flag, Work
 * 26's purchasability rule, and a created window. No free-text search, no name/address/city filter.
 */
export class ListBranchOperationsQueryDto {
  @IsUUID()
  @IsOptional()
  pharmacyId?: string;

  /** `true` / `false` — the stored `branches.isActive`. Raw string, as `isCod`. */
  @Transform(({ obj }) => (obj as Record<string, unknown>).isActive)
  @IsIn(['true', 'false'])
  @IsOptional()
  isActive?: 'true' | 'false';

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
  @Max(MAX_BRANCH_OPERATIONS_PAGE_SIZE)
  @IsOptional()
  size?: number;
}
