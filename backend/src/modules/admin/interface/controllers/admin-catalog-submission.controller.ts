import { Controller, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { CurrentUser } from '../../../identity/interface/decorators/current-user.decorator';
import { RequirePermissions } from '../../../../shared/rbac/permissions.decorator';
import { AuthenticatedPrincipal } from '../../../../shared/rbac/rbac.types';
import { SubmitCatalogProductCommand } from '../../application/commands/submit-catalog-product.command';
import { ApprovedProductResponse, toApprovedProductResponse } from '../dtos/catalog-approval.response';

/**
 * Catalogue review submission (module-16 Work 29), beside Work 28's approval and kept out of Work
 * 09's read-only `AdminCatalogReviewController`:
 *
 *     POST /admin/catalog/review/:productId/submit   DRAFT → PENDING_REVIEW; 200 with the product
 *
 * Under `/admin` because product creation and management are administrator-only in Module 03
 * (`POST /admin/catalog/products`, `catalog:manage:any`) — the same key here, ADMIN and SUPER_ADMIN
 * by wildcard. No body, so no target status: a submission cannot skip the review. The id is a UUID
 * (400 otherwise). The response is the same product shape as approval (Module 03's
 * `ProductDetailView`). Audited once, by Module 03, as `PRODUCT_STATUS_CHANGED`.
 */
@Controller('admin/catalog/review')
export class AdminCatalogSubmissionController {
  constructor(private readonly submit: SubmitCatalogProductCommand) {}

  @Post(':productId/submit')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('catalog:manage:any')
  async submitOne(
    @CurrentUser() actor: AuthenticatedPrincipal,
    @Param('productId', new ParseUUIDPipe()) productId: string,
  ): Promise<ApprovedProductResponse> {
    return toApprovedProductResponse(await this.submit.execute({ actorUserId: actor.userId, productId }));
  }
}
