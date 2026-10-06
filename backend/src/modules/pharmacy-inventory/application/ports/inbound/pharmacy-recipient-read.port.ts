import { Inject, Injectable } from '@nestjs/common';
import { IPharmacyRepository, PHARMACY_REPOSITORY } from '../../../domain/repositories/pharmacy.repository';
import { IDENTITY_PORT, IIdentityPort } from '../outbound/identity.port';

export const PHARMACY_RECIPIENT_READ_PORT = Symbol('PHARMACY_RECIPIENT_READ_PORT');

/**
 * Module 04's exported contract for **who answers for a pharmacy**, consumed in-process by Module
 * 13 to address pharmacy notifications (module-13 Work 07).
 *
 * The answer is the pharmacy's organization owner — `organizations.ownerUserId`, the one person the
 * platform's ownership model names for a pharmacy (the owner registers the pharmacy and holds the
 * owner-only `pharmacy:manage:org` authority). It is deliberately a single user: no rule in the
 * repository decides which of a pharmacy's managers, pharmacists, cashiers or inventory staff
 * should hear about an administrative change, so none is invented here.
 *
 * One identifier, read-only: no organization, licence, branch or staff data crosses this seam.
 */
export interface IPharmacyRecipientReadPort {
  /** The pharmacy's organization owner `users.id`, or `null` when the pharmacy or its organization does not exist. */
  ownerUserIdOfPharmacy(pharmacyId: string): Promise<string | null>;
}

/**
 * Composes what Module 04 already has: its own `Pharmacy` row for the `organizationId`, and the
 * `IIdentityPort.getOrganizationOwner` read it already uses for owner-scoped decisions. No new
 * query and no second definition of "owner".
 */
@Injectable()
export class PharmacyRecipientReadPortAdapter implements IPharmacyRecipientReadPort {
  constructor(
    @Inject(PHARMACY_REPOSITORY) private readonly pharmacies: IPharmacyRepository,
    @Inject(IDENTITY_PORT) private readonly identity: IIdentityPort,
  ) {}

  async ownerUserIdOfPharmacy(pharmacyId: string): Promise<string | null> {
    const pharmacy = await this.pharmacies.findById(pharmacyId);
    if (!pharmacy) {
      return null;
    }
    const owner = await this.identity.getOrganizationOwner(pharmacy.organizationId);
    return owner?.userId ?? null;
  }
}
