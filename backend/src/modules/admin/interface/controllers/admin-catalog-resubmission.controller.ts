import { Controller, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { CurrentUser } from '../../../identity/interface/decorators/current-user.decorator';
import { RequirePermissions } from '../../../../shared/rbac/permissions.decorator';
import { AuthenticatedPrincipal } from '../../../../shared/rbac/rbac.types';
import { ResubmitCatalogProductCommand } from '../../application/commands/resubmit-catalog-product.command';
import { ApprovedProductResponse, toApprovedProductResponse } from '../dtos/catalog-approval.response';

/**
 * Catalogue review resubmission (module-16 Work 32), beside approval (Work 28), submission (Work 29)
 * and rejection (Work 31):
 *
 *     POST /admin/catalog/review/:productId/resubmit   REJECTED → PENDING_REVIEW; 200 with the product
 *
 * `catalog:manage:any` — ADMIN, SUPER_ADMIN by wildcard. No body: the status is the only thing that
 * changes (corrections go through `PATCH /admin/catalog/products/:id` first). The id is a UUID (400
 * otherwise). Same product response shape as the other review routes; no rejection reason in it.
 */
@Controller('admin/catalog/review')
export class AdminCatalogResubmissionController {
  constructor(private readonly resubmit: ResubmitCatalogProductCommand) {}

  @Post(':productId/resubmit')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('catalog:manage:any')
  async resubmitOne(
    @CurrentUser() actor: AuthenticatedPrincipal,
    @Param('productId', new ParseUUIDPipe()) productId: string,
  ): Promise<ApprovedProductResponse> {
    return toApprovedProductResponse(await this.resubmit.execute({ actorUserId: actor.userId, productId }));
  }
}
