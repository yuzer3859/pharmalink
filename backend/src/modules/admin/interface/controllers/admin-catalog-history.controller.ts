import { Controller, Get, Param, ParseUUIDPipe } from '@nestjs/common';
import { RequirePermissions } from '../../../../shared/rbac/permissions.decorator';
import { GetCatalogReviewHistoryQuery } from '../../application/queries/get-catalog-review-history.query';
import { CatalogReviewHistoryResponse, toCatalogReviewHistoryResponse } from '../dtos/catalog-review-history.response';

/**
 * Catalogue review history (module-16 Work 33) — read-only:
 *
 *     GET /admin/catalog/review/:productId/history   { productId, history: [{ from, to, occurredAt, reason }] }
 *
 * `catalog:manage:any` — the review surface's key (Work 09, Works 28–32), ADMIN and SUPER_ADMIN by
 * wildcard. Not `audit:read:any`: this is one product's review record for its curators, not the
 * platform-wide trail, and it returns four fields of each entry rather than the entry. The one place a
 * rejection reason is shown; no product response carries it. The id is a UUID (400 otherwise);
 * unknown or deleted → 404. Writes nothing.
 */
@Controller('admin/catalog/review')
export class AdminCatalogHistoryController {
  constructor(private readonly history: GetCatalogReviewHistoryQuery) {}

  @Get(':productId/history')
  @RequirePermissions('catalog:manage:any')
  async historyOf(@Param('productId', new ParseUUIDPipe()) productId: string): Promise<CatalogReviewHistoryResponse> {
    return toCatalogReviewHistoryResponse(await this.history.execute(productId));
  }
}
