import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../../../shared/audit/audit.service';
import { ApiException } from '../../../../shared/errors/api-exception';
import { ErrorCode } from '../../../../shared/errors/error-codes';
import {
  IDENTITY_ORGANIZATION_READ_PORT,
  type IIdentityOrganizationReadPort,
} from '../../../identity/application/ports/inbound/identity-organization-read.port';
import {
  IDENTITY_PHARMACY_ONBOARDING_PORT,
  type IIdentityPharmacyOnboardingPort,
  type OwnerLicenceDocument,
} from '../../../identity/application/ports/inbound/identity-pharmacy-onboarding.port';
import {
  PHARMACY_ONBOARDING_PORT,
  type IPharmacyOnboardingPort,
} from '../../../pharmacy-inventory/application/ports/inbound/pharmacy-onboarding.port';

export interface RegisterPharmacyForOwnerInput {
  actorUserId: string;
  ownerUserId: string;
  /** The organisation's legal name. */
  legalName: string;
  /** The storefront name customers see. */
  displayName: string;
  licenseNumber: string;
  /** The licence's last valid day; it expires at the end of that day (UTC). */
  licenseExpiresOn: string;
  documents: OwnerLicenceDocument[];
  /** One per registration form, so a retry after a failure continues instead of duplicating. */
  idempotencyKey: string;
  ip: string | null;
}

export interface PharmacyRegistrationResult {
  organizationId: string;
  pharmacyId: string;
  ownerUserId: string;
}

/** End of the given `YYYY-MM-DD` day in UTC, as the verification queue sends licence expiries. */
export function endOfDayUtc(day: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const date = new Date(`${day}T23:59:59.999Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== day ? null : date;
}

/**
 * Work 154: the Super Admin registers a pharmacy for an owner — the owner's account, found by
 * e-mail, gets a new pharmacy organisation (one owner may hold several), its licence files and
 * number, the licence approval, the storefront and its activation, in one request. Every step is
 * the command the owner's own flow uses, so every rule still applies; the administrator is
 * recorded as the licence reviewer and the activator, and the whole registration is audited as
 * `PHARMACY_REGISTERED_BY_ADMIN`.
 *
 * Retrying with the same `idempotencyKey` continues where a failure stopped: the organisation is
 * the same, an already-approved licence is not submitted again, an existing storefront is reused,
 * and activation changes nothing when it is already active.
 */
@Injectable()
export class PharmacyRegistrationService {
  constructor(
    @Inject(IDENTITY_PHARMACY_ONBOARDING_PORT) private readonly identity: IIdentityPharmacyOnboardingPort,
    @Inject(IDENTITY_ORGANIZATION_READ_PORT) private readonly organizations: IIdentityOrganizationReadPort,
    @Inject(PHARMACY_ONBOARDING_PORT) private readonly pharmacies: IPharmacyOnboardingPort,
    private readonly audit: AuditService,
  ) {}

  requestUpload(input: { ownerUserId: string; contentType: string; bytes: number; ip: string | null }) {
    return this.identity.requestOwnerDocumentUpload(input);
  }

  async register(input: RegisterPharmacyForOwnerInput): Promise<PharmacyRegistrationResult> {
    const expiresAt = endOfDayUtc(input.licenseExpiresOn);
    if (!expiresAt) throw new ApiException(ErrorCode.VALIDATION_ERROR, 'The licence expiry must be a date.', { field: 'licenseExpiresOn' });
    if (expiresAt.getTime() <= Date.now()) {
      throw new ApiException(ErrorCode.VALIDATION_ERROR, 'The licence has already expired.', { field: 'licenseExpiresOn' });
    }

    const { organizationId } = await this.identity.applyOrganization({
      ownerUserId: input.ownerUserId,
      legalName: input.legalName,
      idempotencyKey: input.idempotencyKey,
      ip: input.ip,
    });

    const organization = await this.organizations.getOrganizationPeople(organizationId);
    if (organization?.status !== 'ACTIVE') {
      const { requestId } = await this.identity.submitLicence({ ownerUserId: input.ownerUserId, organizationId, documents: input.documents, ip: input.ip });
      await this.identity.approveLicence({ requestId, reviewerId: input.actorUserId, licenseNumber: input.licenseNumber.trim(), expiresAt, ip: input.ip });
    }

    const existing = await this.pharmacies.findByOrganization(organizationId);
    const { pharmacyId } =
      existing ?? (await this.pharmacies.register({ ownerUserId: input.ownerUserId, organizationId, displayName: input.displayName.trim() }));
    await this.pharmacies.activate({ actorUserId: input.actorUserId, pharmacyId });

    await this.audit.record({
      actorUserId: input.actorUserId,
      action: 'PHARMACY_REGISTERED_BY_ADMIN',
      resourceType: 'Pharmacy',
      resourceId: pharmacyId,
      context: { organizationId, ownerUserId: input.ownerUserId, licenseNumber: input.licenseNumber.trim(), documentCount: input.documents.length },
      ip: input.ip,
    });
    return { organizationId, pharmacyId, ownerUserId: input.ownerUserId };
  }
}
