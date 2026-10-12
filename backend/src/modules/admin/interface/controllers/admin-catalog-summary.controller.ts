import { Controller, Get } from '@nestjs/common';
import { RequirePermissions } from '../../../../shared/rbac/permissions.decorator';
import { GetCatalogReviewSummaryQuery } from '../../application/queries/get-catalog-review-summary.query';
import { CatalogReviewSummaryResponse, toCatalogReviewSummaryResponse } from '../dtos/catalog-review-summary.response';

/**
 * Catalogue review summary (module-16 Work 34) — read-only:
 *
 *     GET /admin/catalog/review/summary   queue size and oldest wait; lifetime approvals, rejections, resubmissions
 *
 * `catalog:manage:any` — the review surface's key, ADMIN and SUPER_ADMIN by wildcard. Aggregates
 * only: no product, actor, reason or audit entry. Kept out of Work 09's list controller so that
 * controller stays a single route. Writes nothing.
 */
@Controller('admin/catalog/review')
export class AdminCatalogSummaryController {
  constructor(private readonly summary: GetCatalogReviewSummaryQuery) {}

  @Get('summary')
  @RequirePermissions('catalog:manage:any')
  async getSummary(): Promise<CatalogReviewSummaryResponse> {
    return toCatalogReviewSummaryResponse(await this.summary.execute());
  }
}
