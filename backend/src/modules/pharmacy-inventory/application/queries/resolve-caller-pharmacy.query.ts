import { Inject, Injectable } from '@nestjs/common';
import { PharmacyInventoryErrors } from '../../domain/errors';
import { Pharmacy } from '../../domain/entities/pharmacy.entity';
import { IPharmacyRepository, PHARMACY_REPOSITORY } from '../../domain/repositories/pharmacy.repository';
import { IDENTITY_PORT, IIdentityPort } from '../ports/outbound/identity.port';

/**
 * Resolves the `Pharmacy` owned by the calling user's organization (module-04 §7.3, §15) —
 * org-scope is validated in the application layer by comparing the resolved
 * `Pharmacy.organizationId` against the caller's `user_roles.organizationId`, never trusted
 * from a client-supplied path param alone.
 */
@Injectable()
export class ResolveCallerPharmacyQuery {
  constructor(
    @Inject(PHARMACY_REPOSITORY) private readonly pharmacies: IPharmacyRepository,
    @Inject(IDENTITY_PORT) private readonly identity: IIdentityPort,
  ) {}

  async execute(userId: string): Promise<Pharmacy> {
    const organizationIds = await this.identity.getUserOrganizationIds(userId);
    for (const organizationId of organizationIds) {
      const pharmacy = await this.pharmacies.findByOrganizationId(organizationId);
      if (pharmacy) {
        return pharmacy;
      }
    }
    throw PharmacyInventoryErrors.notFound('No pharmacy is registered for this user.');
  }
}
