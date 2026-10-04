import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

const MAX_ID_LENGTH = 64;

/**
 * The largest captured-payment sweep a caller may request.
 *
 * Deliberately bounded. Every payment examined costs one posting read plus one account lookup per
 * leg, so an unbounded `limit` would let a single admin request hold a connection open across the
 * whole payment history. A caller who needs more depth than this runs the sweep again — the
 * endpoint is read-only, so repeating it is free of consequence.
 */
export const MAX_RECONCILIATION_LIMIT = 5_000;

/**
 * `GET /admin/finance/reconciliation` (§9.6, F-REC-01).
 *
 * **Only the two options `AccountingReconciliationService.run()` actually takes.** No date range,
 * no anomaly-kind filter, no settlement-status filter — none of those exist in the service, and
 * adding query parameters that a controller would have to implement itself would mean the HTTP
 * layer deciding what "reconciled" means. That decision belongs to the service.
 *
 * ## `pharmacyId` narrows less than it looks like it does
 *
 * It narrows the **settlement** checks only — duplicate statements, line mismatches, total
 * mismatches. The capture-posting checks and the ledger-balance check stay platform-wide, because
 * `PLATFORM_REVENUE` and `PROMOTION_EXPENSE` are platform-level accounts and a ledger imbalance is
 * not attributable to one provider in the first place. The response says so explicitly in its
 * `scope` block rather than leaving an operator to infer it from an empty anomaly list.
 *
 * It is a convenience for an operator investigating one provider, never an authorization
 * boundary: reaching this route at all requires `finance:report:any`, which is platform-wide.
 */
export class GetReconciliationQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(MAX_ID_LENGTH)
  pharmacyId?: string;

  /** How many captured/refunded payments to examine. Defaults to the service's own limit. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_RECONCILIATION_LIMIT)
  limit?: number;
}
