import { Controller, Get, HttpCode, HttpStatus, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { RequirePermissions } from '../../../../shared/rbac/permissions.decorator';
import { AuthenticatedPrincipal } from '../../../../shared/rbac/rbac.types';
import { CurrentUser } from '../../../identity/interface/decorators/current-user.decorator';
import { AnalyticsSnapshotService } from '../../application/analytics/analytics-snapshot.service';
import { GetAnalyticsOverviewQuery } from '../../application/queries/get-analytics-overview.query';
import { AnalyticsTimeseriesQueryDto } from '../dtos/analytics-timeseries.dto';
import { AnalyticsOverviewResponse, toAnalyticsOverviewResponse } from '../dtos/analytics.response';

/**
 * Operational analytics (module-16 §9.7, F-AD-23/24) — the control plane's **read-only** view of
 * measurable marketplace activity.
 *
 *     GET  /admin/analytics/overview     accounts, catalogue, providers, orders, delivery, COD — now
 *     GET  /admin/analytics/metrics      the metric keys daily snapshots hold (Work 87)
 *     GET  /admin/analytics/timeseries   ?metrics=a,b&from=YYYY-MM-DD&to=YYYY-MM-DD (Work 87)
 *     POST /admin/analytics/snapshots    take today's snapshot now; replaces today's values (Work 87)
 *
 * Work 87 adds the time series from daily snapshots (backend/docs/analytics-timeseries.md). The
 * notes below on one route and read-only describe the overview; the one write Work 87 adds is to
 * Admin's own read model (`dashboard_metrics`), never to an owner's table, and is audited.
 *
 * ## One route, on purpose
 *
 * The overview is the dashboard. No `/orders`, `/delivery` or `/pharmacies` detail route is
 * added: each would be a section of this response served again under its own path, and the row
 * lists an operator drills into already exist where their owners serve them (`/admin/accounts`,
 * `/admin/catalog`, `/admin/delivery/cod-reconciliation`, the pharmacy and order surfaces).
 * No query string either — see `GetAnalyticsOverviewQuery` for why a period is deferred.
 *
 * ## Read-only, structurally
 *
 * One `@Get`. The query behind it holds six read ports and nothing else; none of them exposes a
 * command, and the one Module 08 port that could (`ICodDisputeAdminPort`) is not injected here.
 *
 * ## Authorization — `analytics:read`
 *
 * The key the design assigns to `/admin/analytics/*` (§9.7), added to the catalogue by this work
 * and granted to `ADMIN` (and to `SUPER_ADMIN` by wildcard). Not `finance:report:any`: that is the
 * finance desk's reporting authority and five of the six sections are not finance. Not
 * `rbac:read`: that reads accounts, and this reads counts of everything. The `cod` section is the
 * same aggregate Module 08 serves under `finance:report:any`; every holder of `analytics:read`
 * today also holds that key, and a future grant that separated them would need to decide whether
 * cash totals belong on an operations dashboard — stated here so it is a decision, not a leak.
 *
 * ## Audit
 *
 * Nothing is written. Re-checked in this work: the repository still has no sensitive-read audit
 * convention, and aggregate counts are the least sensitive read in the platform.
 *
 * Errors are not caught — the global filter maps them; the only ones possible here are
 * `UNAUTHENTICATED` (401) and `FORBIDDEN` (403).
 */
@Controller('admin/analytics')
@RequirePermissions('analytics:read')
export class AdminAnalyticsController {
  constructor(
    private readonly overview: GetAnalyticsOverviewQuery,
    private readonly snapshots: AnalyticsSnapshotService,
  ) {}

  @Get('overview')
  async getOverview(): Promise<AnalyticsOverviewResponse> {
    return toAnalyticsOverviewResponse(await this.overview.execute());
  }

  @Get('metrics')
  async listMetrics(): Promise<{ metrics: string[] }> {
    return { metrics: await this.snapshots.listMetrics() };
  }

  @Get('timeseries')
  async timeseries(@Query() q: AnalyticsTimeseriesQueryDto) {
    return this.snapshots.timeseries({ metrics: q.metrics.split(','), from: q.from, to: q.to });
  }

  /** Idempotent by construction: a second run the same day replaces that day's values. */
  @Post('snapshots')
  @HttpCode(HttpStatus.OK)
  async takeSnapshot(@CurrentUser() user: AuthenticatedPrincipal, @Req() req: Request) {
    const result = await this.snapshots.snapshot({ userId: user.userId, ip: req.ip ?? null });
    return { day: result.day, metrics: result.metrics, takenAt: result.takenAt.toISOString() };
  }
}
