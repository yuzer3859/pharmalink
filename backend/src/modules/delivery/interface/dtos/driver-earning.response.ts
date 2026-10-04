import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { DriverEarningProps } from '../../domain/entities/driver-earning.entity';
import {
  DriverEarningsView,
  MAX_EARNINGS_PAGE_SIZE,
} from '../../application/queries/get-driver-earnings.query';

/**
 * Paging for `GET /driver/earnings`.
 *
 * Two fields, and deliberately no filters. A `driverId` parameter is the obvious thing to add and
 * is exactly what must not exist: scope comes from the access token, and a query parameter that
 * could widen it would be an authorization decision handed to the caller. Date ranges and status
 * filters are absent for a smaller reason — nobody needs them yet, and the design's route is
 * "earnings ledger + summary".
 *
 * `forbidNonWhitelisted` makes an unexpected parameter a `400` rather than something silently
 * ignored.
 */
export class DriverEarningsQueryDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_EARNINGS_PAGE_SIZE)
  @IsOptional()
  limit?: number;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  @IsOptional()
  offset?: number;
}

/**
 * One line of a driver's earnings ledger (§3.5 F-ERN-02).
 *
 * ## An accrual, not a payment
 *
 * `status` is the honest distinction and is the field a driver most needs to read correctly:
 * `ACCRUED` means the platform has *recorded* what it owes for this delivery, not that it has paid
 * it. Delivery never writes anything else — `SETTLED` is Module 07's to set when a settlement
 * actually moves money — so a driver seeing `ACCRUED` is seeing the truth about what this module
 * knows, and this module does not know whether they have been paid.
 *
 * The four components are included rather than only the total, because "why is this delivery worth
 * less than that one" is the question a driver actually asks, and the answer — a longer route, a
 * different agreement — is only visible in the breakdown. `calculationVersion` names the agreement
 * the amount was computed under, so an amount from two months ago is explainable without anybody
 * reverse-engineering today's configuration.
 *
 * ## What is absent
 *
 * No bank account, no wallet id, no payout reference, no schedule: Module 08 holds none of it and
 * a driver's banking details have no business on a delivery module's response. No customer
 * identity, no address and no order contents either — an earnings line is about a delivery's
 * economics, not about who lives where.
 *
 * `orderId` and `fulfillmentId` are included: they are the references a driver quotes to support
 * when querying a payment, and they identify nobody.
 */
export interface DriverEarningResponse {
  id: string;
  jobId: string;
  orderId: string;
  fulfillmentId: string;
  /** Minor units (ADR-005). */
  base: number;
  distanceComponent: number;
  feeShare: number;
  incentive: number;
  total: number;
  currency: string;
  /** `ACCRUED` for everything this module writes. See the type's note. */
  status: string;
  /** The delivery's frozen distance, or `null` where the job never had one. */
  distanceMeters: number | null;
  calculationVersion: string;
  /** ISO-8601, server clock. */
  accruedAt: string;
}

/** A page of the ledger, with the summary §9.2's route names. */
export interface DriverEarningsResponse {
  items: DriverEarningResponse[];
  total: number;
  limit: number;
  offset: number;
  /** Sum of the items on **this page**. See `DriverEarningsView` for why it is not a lifetime total. */
  pageTotal: number;
  currency: string;
}

export function toDriverEarningResponse(earning: DriverEarningProps): DriverEarningResponse {
  return {
    id: earning.id,
    jobId: earning.jobId,
    orderId: earning.orderId,
    fulfillmentId: earning.fulfillmentId,
    base: earning.base,
    distanceComponent: earning.distanceComponent,
    feeShare: earning.feeShare,
    incentive: earning.incentive,
    total: earning.total,
    currency: earning.currency,
    status: earning.status,
    distanceMeters: earning.distanceMeters,
    calculationVersion: earning.calculationVersion,
    accruedAt: earning.createdAt.toISOString(),
  };
}

export function toDriverEarningsResponse(view: DriverEarningsView): DriverEarningsResponse {
  return {
    items: view.items.map(toDriverEarningResponse),
    total: view.total,
    limit: view.limit,
    offset: view.offset,
    pageTotal: view.pageTotal,
    currency: view.currency,
  };
}
