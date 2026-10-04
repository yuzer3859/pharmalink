import { Controller, Get, Param, Query } from '@nestjs/common';
import { RequirePermissions } from '../../../../shared/rbac/permissions.decorator';
import { AuthenticatedPrincipal } from '../../../../shared/rbac/rbac.types';
import { CurrentUser } from '../../../identity/interface/decorators/current-user.decorator';
import { GetDriverEarningsQuery } from '../../application/queries/get-driver-earnings.query';
import {
  DriverEarningResponse,
  DriverEarningsQueryDto,
  DriverEarningsResponse,
  toDriverEarningResponse,
  toDriverEarningsResponse,
} from '../dtos/driver-earning.response';

/**
 * A driver's earnings ledger (§9.2's `GET /driver/earnings` — "earnings ledger + summary",
 * F-ERN-02).
 *
 * ## Two routes, and both are reads
 *
 * There is **no write route anywhere in this work.** No POST, no PATCH, no PUT, no DELETE — not
 * for the amount, not for the status, not for a correction, and certainly not for a payout. An
 * earning is computed by the platform from a delivery that already happened and is written once by
 * `AccrueDriverEarningCommand`, which no HTTP route reaches at all. §14's "do NOT expose a route
 * allowing clients to set earning amounts" and "do NOT expose payout actions" are satisfied here
 * by there being nothing to expose: the aggregate has no mutator, the repository has no `update`,
 * and this controller has no verb but `GET`.
 *
 * ## Authorization
 *
 * `delivery:read:own`, which is **the one new RBAC key any of the five works in this module has
 * added**, and it was unavoidable rather than convenient. `DRIVER` held exactly two delivery
 * permissions — `delivery:accept:own` and `delivery:update:own` — and both are write verbs;
 * guarding a read with an `update` key would make the catalogue lie about what the route does, and
 * the first person to audit permissions would have to read the code to find out. The
 * customer-facing reads in this module use `order:read:own` because they genuinely are reads of the
 * customer's own order; a driver's pay is not, so that key does not fit either.
 *
 * It is narrow by construction: `own` scope, granted only to `DRIVER`, and it authorizes nothing
 * but reading delivery records the caller already owns. No finance permission was invented — §13
 * warns against exactly that, and the administrative and finance view of driver earnings arrives
 * with the Module 07 settlement work that will have an actual consumer for it. Until then there is
 * no route through which anybody can read another driver's earnings, which is the right default for
 * a surface that reports what people are paid.
 *
 * The key decides who may ask. `GetDriverEarningsQuery` decides what they may see, and it is the
 * query that is load-bearing: it resolves `driver_profiles.id` from the access token and pushes it
 * into the SQL `where` clause, so no request shape — and no future edit to this controller — can
 * widen the scope.
 *
 * Errors are not caught: `DRIVER_PROFILE_NOT_FOUND` (404) for a caller who is not an operational
 * driver, `NOT_FOUND` (404) for a job that is not theirs or has no earning, and
 * `VALIDATION_ERROR` (400) for malformed paging.
 */
@Controller()
export class DriverEarningsController {
  constructor(private readonly earnings: GetDriverEarningsQuery) {}

  /**
   * The driver's own ledger, newest first, with the page summary.
   *
   * The design's route verbatim. It is the one place in this module that uses a `/driver` prefix,
   * and that is right here where it was wrong for proof of delivery: a PoD belongs to a *delivery
   * job* and was correctly addressed as one, whereas an earnings ledger belongs to the **driver** —
   * there is no job in the path because the resource is the person's own record of what they have
   * earned.
   */
  @Get('driver/earnings')
  @RequirePermissions('delivery:read:own')
  async mine(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Query() query: DriverEarningsQueryDto,
  ): Promise<DriverEarningsResponse> {
    return toDriverEarningsResponse(
      // From the token. The DTO has no field through which a driver id could arrive.
      await this.earnings.forDriver(user.userId, {
        limit: query.limit,
        offset: query.offset,
      }),
    );
  }

  /**
   * What one of the driver's own deliveries earned.
   *
   * Addressed under `delivery/jobs/:id` because here the resource *is* the job — the same prefix
   * the status, tracking and proof-of-delivery reads use, and the convention every driver route in
   * this module has followed since dispatch.
   *
   * A job that is not the caller's, and a job whose earning has not been accrued, answer
   * identically with `404`. That is deliberate: distinguishing them would let a driver discover
   * that a delivery they did not make exists, and had been paid for.
   */
  @Get('delivery/jobs/:id/earning')
  @RequirePermissions('delivery:read:own')
  async forJob(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Param('id') jobId: string,
  ): Promise<DriverEarningResponse> {
    return toDriverEarningResponse(await this.earnings.byJobId(jobId, user.userId));
  }
}
