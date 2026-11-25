import { Inject, Injectable } from '@nestjs/common';
import { runWithSelectedOrganization } from '../../../../shared/http/selected-organization';
import { IPharmacyRepository, PHARMACY_REPOSITORY } from '../../domain/repositories/pharmacy.repository';
import { IDENTITY_PORT, IIdentityPort } from '../ports/outbound/identity.port';

export interface MyPharmacyView {
  pharmacyId: string;
  /** Send it as `X-Organization-Id` to work in this pharmacy. */
  organizationId: string;
  displayName: string;
  transactingStatus: string;
}

/**
 * `GET /pharmacy/mine` (Work 155): every pharmacy the caller works in — an owner's several
 * pharmacies, or the ones a pharmacist is staff at — so the portal can offer a switch. It lists
 * them all whatever `X-Organization-Id` the request carries. Sorted by name.
 */
@Injectable()
export class ListMyPharmaciesQuery {
  constructor(
    @Inject(PHARMACY_REPOSITORY) private readonly pharmacies: IPharmacyRepository,
    @Inject(IDENTITY_PORT) private readonly identity: IIdentityPort,
  ) {}

  async execute(userId: string): Promise<MyPharmacyView[]> {
    const organizationIds = await runWithSelectedOrganization(null, () => this.identity.getUserOrganizationIds(userId));
    const found = await Promise.all(organizationIds.map((id) => this.pharmacies.findByOrganizationId(id)));
    return found
      .filter((p): p is NonNullable<typeof p> => p !== null)
      .map((p) => p.toProps())
      .map((p) => ({ pharmacyId: p.id, organizationId: p.organizationId, displayName: p.displayName, transactingStatus: p.transactingStatus }))
      .sort((a, b) => a.displayName.localeCompare(b.displayName));
  }
}
