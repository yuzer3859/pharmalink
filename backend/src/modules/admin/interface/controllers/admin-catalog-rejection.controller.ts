import { Body, Controller, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { CurrentUser } from '../../../identity/interface/decorators/current-user.decorator';
import { RequirePermissions } from '../../../../shared/rbac/permissions.decorator';
import { AuthenticatedPrincipal } from '../../../../shared/rbac/rbac.types';
import { RejectCatalogProductCommand } from '../../application/commands/reject-catalog-product.command';
import { ApprovedProductResponse, toApprovedProductResponse } from '../dtos/catalog-approval.response';
import { RejectCatalogProductDto } from '../dtos/catalog-rejection.dto';

/**
 * Catalogue review rejection (module-16 Work 31), beside Work 28's approval and Work 29's
 * submission:
 *
 *     POST /admin/catalog/review/:productId/reject   { reason }   PENDING_REVIEW → REJECTED; 200 with the product
 *
 * `catalog:manage:any` — ADMIN, SUPER_ADMIN by wildcard. The id is a UUID (400 otherwise); the reason
 * is required (`RejectCatalogProductDto`). The response is the same product shape as approval and
 * submission (Module 03's `ProductDetailView`) — the reason is not in it; it is in Module 03's audit
 * entry and outbox event, the only record of the decision.
 */
@Controller('admin/catalog/review')
export class AdminCatalogRejectionController {
  constructor(private readonly reject: RejectCatalogProductCommand) {}

  @Post(':productId/reject')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('catalog:manage:any')
  async rejectOne(
    @CurrentUser() actor: AuthenticatedPrincipal,
    @Param('productId', new ParseUUIDPipe()) productId: string,
    @Body() dto: RejectCatalogProductDto,
  ): Promise<ApprovedProductResponse> {
    return toApprovedProductResponse(await this.reject.execute({ actorUserId: actor.userId, productId, reason: dto.reason }));
  }
}
