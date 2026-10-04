import { Controller, Get, Query } from '@nestjs/common';
import { RequirePermissions } from '../../../../shared/rbac/permissions.decorator';
import { AuthenticatedPrincipal } from '../../../../shared/rbac/rbac.types';
import { CurrentUser } from '../../../identity/interface/decorators/current-user.decorator';
import { ListDriverJobsQuery } from '../../application/queries/list-driver-jobs.query';
import { ListDriverJobsQueryDto } from '../dtos/driver-job.dto';
import {
  DriverJobsPageResponse,
  toDriverJobsPageResponse,
} from '../dtos/driver-job.response';

/**
 * `GET /driver/jobs` — the authenticated driver's own work (§9.1's "active + offered jobs").
 *
 * ## Why its own controller, and its own prefix
 *
 * `DriverJobController` is mounted at `delivery/jobs` and every route on it addresses **one** job
 * by id. This addresses the *driver*, and the design names the path separately for that reason:
 * `/driver/jobs` is "my work", `/delivery/jobs/{id}/...` is "this job". Mounting the list at
 * `GET /delivery/jobs` would have read as the collection those item routes belong to — a platform
 * list of all delivery jobs — which is `GET /admin/delivery/jobs`, a different surface with a
 * different authority that this work does not build.
 *
 * ## Authorization
 *
 * `delivery:read:own`, an existing catalogue key already granted to `DRIVER` — no permission is
 * invented and none is regranted. It is the read counterpart of the `delivery:update:own` the
 * status routes use, and naming it here rather than reusing the update key matters: a token scoped
 * to reading a driver's own work should not also be able to advance a delivery.
 *
 * ## Scope, and why a driver id cannot widen it
 *
 * Three independent barriers, so that no single change re-opens the hole:
 *
 *  1. `ListDriverJobsQueryDto` has **no** `driverId` field, and the global `ValidationPipe` runs
 *     with `forbidNonWhitelisted`, so a request that sends one is rejected rather than ignored.
 *  2. The controller passes `user.userId` from the verified access token. There is no code path
 *     here that reads a driver from the request.
 *  3. `ListDriverJobsQuery` resolves that user to a `driver_profiles.id` and filters on it
 *     unconditionally; a user with no driver profile is refused, never served unfiltered.
 *
 * A driver therefore cannot see another driver's jobs, and cannot learn that another driver's job
 * exists — an id they do not own simply is not in the result, with no error that would distinguish
 * "not yours" from "not there".
 *
 * ## What it does not serve
 *
 * No earnings, no proof-of-delivery artifacts, no COD remittance or reconciliation detail, no
 * customer identity. Each has its own read behind its own permission; see
 * `DriverJobSummaryResponse` for the field-by-field reasoning.
 */
@Controller('driver/jobs')
export class DriverJobsListController {
  constructor(private readonly jobs: ListDriverJobsQuery) {}

  @Get()
  @RequirePermissions('delivery:read:own')
  async list(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Query() query: ListDriverJobsQueryDto,
  ): Promise<DriverJobsPageResponse> {
    return toDriverJobsPageResponse(
      await this.jobs.execute({
        // From the token, never from the request.
        userId: user.userId,
        status: query.status,
        page: query.page,
        size: query.size,
      }),
    );
  }
}
