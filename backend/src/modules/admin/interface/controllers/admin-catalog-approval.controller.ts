import { Controller, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { CurrentUser } from '../../../identity/interface/decorators/current-user.decorator';
import { RequirePermissions } from '../../../../shared/rbac/permissions.decorator';
import { AuthenticatedPrincipal } from '../../../../shared/rbac/rbac.types';
import { ApproveCatalogProductCommand } from '../../application/commands/approve-catalog-product.command';
import { ApprovedProductResponse, toApprovedProductResponse } from '../dtos/catalog-approval.response';

/**
 * Catalogue review approval (module-16 Work 28), kept out of Work 09's read-only
 * `AdminCatalogReviewController`:
 *
 *     POST /admin/catalog/review/:productId/approve   PENDING_REVIEW → ACTIVE; 200 with the product
 *
 * `catalog:manage:any` — Work 09's and Module 03's curation key; ADMIN, SUPER_ADMIN by wildcard.
 * No body: the actor comes from the token. The id is a UUID (400 otherwise). Audited once, by
 * Module 03, as `PRODUCT_STATUS_CHANGED`.
 */
@Controller('admin/catalog/review')
export class AdminCatalogApprovalController {
  constructor(private readonly approve: ApproveCatalogProductCommand) {}

  @Post(':productId/approve')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('catalog:manage:any')
  async approveOne(
    @CurrentUser() actor: AuthenticatedPrincipal,
    @Param('productId', new ParseUUIDPipe()) productId: string,
  ): Promise<ApprovedProductResponse> {
    return toApprovedProductResponse(await this.approve.execute({ actorUserId: actor.userId, productId }));
  }
}
