import { Inject, Injectable } from '@nestjs/common';
import { PrescriptionMatchingErrors } from '../../domain/errors';
import { IIdentityPort, IDENTITY_PORT } from '../ports/outbound/identity.port';

const PHARMACIST_ROLE_KEY = 'PHARMACIST';

/**
 * Resolves the calling pharmacist's own verifying-pharmacy organization id (module-05 §7.3,
 * §10.2) — `GET /pharmacy/verification/queue` needs to know "which pharmacy's queue is mine"
 * before calling `GetVerificationQueueQuery` (which, mirroring Module 04's
 * `ListListingsQuery`/`ResolveCallerPharmacyQuery` split, takes an already-resolved
 * `verifyingPharmacyId` rather than resolving it itself). Slice 1 assumes a `PHARMACIST` holds
 * that role at exactly one organization (the same single-org assumption
 * `ResolveCallerPharmacyQuery` makes for `PHARMACY_OWNER`); if the caller holds the role at more
 * than one, the first organization id returned by `IIdentityPort.getUserOrganizationIds()` is
 * used. Own copy per ADR-002 — this module's `IIdentityPort`, not Module 04's.
 */
@Injectable()
export class ResolveCallerVerificationOrgQuery {
  constructor(@Inject(IDENTITY_PORT) private readonly identity: IIdentityPort) {}

  async execute(userId: string): Promise<string> {
    const organizationIds = await this.identity.getUserOrganizationIds(userId);
    for (const organizationId of organizationIds) {
      if (await this.identity.hasRoleAtOrganization(userId, organizationId, PHARMACIST_ROLE_KEY)) {
        return organizationId;
      }
    }
    throw PrescriptionMatchingErrors.verificationForbidden();
  }
}
