import { Controller, Get } from '@nestjs/common';
import { RequirePermissions } from '../../../../shared/rbac/permissions.decorator';
import { AuthenticatedPrincipal } from '../../../../shared/rbac/rbac.types';
import { CurrentUser } from '../../../identity/interface/decorators/current-user.decorator';
import { GetPharmacyDashboardQuery } from '../../application/queries/get-pharmacy-dashboard.query';

/**
 * Work 115: `GET /pharmacy/dashboard` (module-04 §9.1): the caller's pharmacies' orders,
 * revenue and stock health. `order:read:org`, which the owner, managers, pharmacists and cashiers
 * hold. No customer data.
 */
@Controller('pharmacy/dashboard')
export class PharmacyDashboardController {
  constructor(private readonly dashboard: GetPharmacyDashboardQuery) {}

  @Get()
  @RequirePermissions('order:read:org')
  get(@CurrentUser() user: AuthenticatedPrincipal) {
    return this.dashboard.execute({ actorUserId: user.userId });
  }
}
