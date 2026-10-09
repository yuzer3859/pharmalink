import { Controller, Get, Query } from '@nestjs/common';
import { RequirePermissions } from '../../../../shared/rbac/permissions.decorator';
import { ListCatalogReviewQuery } from '../../application/queries/list-catalog-review.query';
import { ListCatalogReviewQueryDto } from '../dtos/catalog-review.dto';
import { CatalogReviewListResponse, toCatalogReviewListResponse } from '../dtos/catalog-review.response';

/**
 * Catalogue governance (module-16 Work 09) — the administrator's **read-only** list of catalogue
 * products by lifecycle status.
 *
 *     GET /admin/catalog/review   ?status (default DRAFT) &type &q &page &size
 *
 * ## Beside Module 03's routes, not over them
 *
 * `/admin/catalog/*` is Module 03's curation surface: `GET|PATCH products/:id`, `POST products`,
 * `POST products/:id/status`, `categories`, `manufacturers`. `review` is the one path segment
 * added, and it collides with none of them. Two things are deliberately not added:
 *
 * - **No detail route.** `GET /admin/catalog/products/:id` already serves the full record under
 *   the same permission; a `review/:id` would be that response served again.
 * - **No approve/reject.** Module 03 has no proposal workflow — a product's decision is a status
 *   transition, and `POST /admin/catalog/products/:id/status` performs it with its own state
 *   machine, audit entry and outbox event in one transaction. Wrapping it here would write a
 *   second audit row for one decision and offer two routes for one command. Each row's
 *   `allowedTransitions` tells the caller what that route will accept. (Work 28 later added
 *   `POST review/:productId/approve` in `AdminCatalogApprovalController` — the `PENDING_REVIEW ->
 *   ACTIVE` decision only, delegated to that same command, with Module 03's one audit row.)
 *
 * ## Authorization — `catalog:manage:any`
 *
 * The key Module 03's own admin routes require, including its admin read of one product: the
 * catalogue curator's authority, held by `ADMIN` (and `SUPER_ADMIN` by wildcard). Not
 * `catalog:read:any`: that is reserved for an authenticated variant of the public reads, granted
 * to no role, and granting it would widen access rather than reuse it. No new key.
 *
 * ## Audit
 *
 * Nothing is written: this is a read, and the repository still has no sensitive-read audit
 * convention. Errors are not caught — the global filter maps them: `VALIDATION_ERROR` (400),
 * `UNAUTHENTICATED` (401), `FORBIDDEN` (403).
 */
@Controller('admin/catalog/review')
@RequirePermissions('catalog:manage:any')
export class AdminCatalogReviewController {
  constructor(private readonly listReview: ListCatalogReviewQuery) {}

  @Get()
  async list(@Query() query: ListCatalogReviewQueryDto): Promise<CatalogReviewListResponse> {
    return toCatalogReviewListResponse(
      await this.listReview.execute({
        status: query.status,
        type: query.type,
        q: query.q,
        page: query.page,
        size: query.size,
      }),
    );
  }
}
