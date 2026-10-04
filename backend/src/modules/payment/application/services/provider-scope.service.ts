import { Inject, Injectable } from '@nestjs/common';
import { IDENTITY_PORT, IIdentityPort } from '../ports/outbound/identity.port';
import { IPharmacyPort, PHARMACY_PORT } from '../ports/outbound/pharmacy.port';

/**
 * Resolves *which providers* an authenticated caller may see settlement statements for.
 *
 * `@RequirePermissions('settlement:read:org')` establishes **that** a caller may read provider
 * statements; it says nothing about **whose**. That second question is answered here, server-side,
 * from the access token's subject and nothing else — no route, DTO or body in this module accepts
 * an organization id, and the one `pharmacyId` a client may send is a *filter* intersected with
 * this result, never a substitute for it.
 *
 * The two hops are the same ones Module 06's `ListPharmacyOrdersQuery` uses, for the same reason:
 *  1. `IIdentityPort.getUserOrganizationIds()` → the caller's `Organization.id`s (what
 *     `user_roles.organizationId` stores).
 *  2. `IPharmacyPort.findPharmacyIdsByOrganizationIds()` → the `Pharmacy.id`s those organizations
 *     own, which is what `settlements.pharmacyId` is keyed by.
 *
 * An empty result is returned as an empty array, never as "unrestricted". That distinction is the
 * whole safety property of this class: callers must treat `[]` as *no statements are visible*, and
 * every caller in this module does.
 */
@Injectable()
export class ProviderScopeService {
  constructor(
    @Inject(IDENTITY_PORT) private readonly identity: IIdentityPort,
    @Inject(PHARMACY_PORT) private readonly pharmacies: IPharmacyPort,
  ) {}

  async resolvePharmacyIds(userId: string): Promise<string[]> {
    const organizationIds = await this.identity.getUserOrganizationIds(userId);
    if (organizationIds.length === 0) {
      return [];
    }
    return this.pharmacies.findPharmacyIdsByOrganizationIds(organizationIds);
  }
}
