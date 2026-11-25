import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../../../shared/audit/audit.service';
import { ApiException } from '../../../../shared/errors/api-exception';
import { ErrorCode } from '../../../../shared/errors/error-codes';
import {
  IDENTITY_FACILITY_ONBOARDING_PORT,
  type IIdentityFacilityOnboardingPort,
} from '../../../identity/application/ports/inbound/identity-facility-onboarding.port';
import {
  IDENTITY_ORGANIZATION_READ_PORT,
  type IIdentityOrganizationReadPort,
} from '../../../identity/application/ports/inbound/identity-organization-read.port';
import type { OwnerLicenceDocument } from '../../../identity/application/ports/inbound/identity-pharmacy-onboarding.port';
import {
  PROVIDER_ADMIN_READ_PORT,
  type IProviderAdminReadPort,
  type ProviderRecord,
} from '../../../provider-directory/application/ports/inbound/provider-admin-read.port';
import {
  PROVIDER_ONBOARDING_PORT,
  type IProviderOnboardingPort,
} from '../../../provider-directory/application/ports/inbound/provider-onboarding.port';
import { organizationTypeFor, type ProviderStatus, type ProviderType } from '../../../provider-directory/domain/provider-rules';
import { endOfDayUtc } from './pharmacy-registration.service';

export interface RegisterProviderInput {
  actorUserId: string;
  /** The facility's administrator: an existing, active, e-mail-verified customer account. */
  adminUserId: string;
  type: ProviderType;
  legalName: string;
  displayName: string;
  licenseNumber: string;
  /** The licence's last valid day (`YYYY-MM-DD`); it expires at the end of that day (UTC). */
  licenseExpiresOn: string;
  documents: OwnerLicenceDocument[];
  idempotencyKey: string;
  ip: string | null;
}

/**
 * Work 160: the Super Admin registers a hospital, clinic, diagnostic centre or lab for its
 * administrator, and controls it afterwards — the facility twin of Work 154's pharmacy
 * registration. One request applies for the organisation (the administrator gets
 * `HOSPITAL_ADMIN` or `DIAGNOSTIC_CENTER_ADMIN` there), submits and approves its facility licence
 * with the Super Admin as reviewer, creates the directory profile and activates it. Every step is
 * the owning module's own command, so every rule applies. Retrying with the same
 * `idempotencyKey` continues where a failure stopped.
 */
@Injectable()
export class ProviderRegistrationService {
  constructor(
    @Inject(IDENTITY_FACILITY_ONBOARDING_PORT) private readonly identity: IIdentityFacilityOnboardingPort,
    @Inject(IDENTITY_ORGANIZATION_READ_PORT) private readonly organizations: IIdentityOrganizationReadPort,
    @Inject(PROVIDER_ONBOARDING_PORT) private readonly providers: IProviderOnboardingPort,
    @Inject(PROVIDER_ADMIN_READ_PORT) private readonly reads: IProviderAdminReadPort,
    private readonly audit: AuditService,
  ) {}

  requestUpload(input: { adminUserId: string; contentType: string; bytes: number; ip: string | null }) {
    return this.identity.requestAdminDocumentUpload(input);
  }

  async register(input: RegisterProviderInput): Promise<{ organizationId: string; providerId: string; adminUserId: string }> {
    const expiresAt = endOfDayUtc(input.licenseExpiresOn);
    if (!expiresAt) throw new ApiException(ErrorCode.VALIDATION_ERROR, 'The licence expiry must be a date.', { field: 'licenseExpiresOn' });
    if (expiresAt.getTime() <= Date.now()) {
      throw new ApiException(ErrorCode.VALIDATION_ERROR, 'The licence has already expired.', { field: 'licenseExpiresOn' });
    }

    const { organizationId } = await this.identity.applyOrganization({
      adminUserId: input.adminUserId,
      type: organizationTypeFor(input.type),
      legalName: input.legalName,
      idempotencyKey: input.idempotencyKey,
      ip: input.ip,
    });

    const organization = await this.organizations.getOrganizationPeople(organizationId);
    if (organization?.status !== 'ACTIVE') {
      const { requestId } = await this.identity.submitLicence({ adminUserId: input.adminUserId, organizationId, documents: input.documents, ip: input.ip });
      await this.identity.approveLicence({ requestId, reviewerId: input.actorUserId, licenseNumber: input.licenseNumber.trim(), expiresAt, ip: input.ip });
    }

    const existing = await this.providers.findByOrganization(organizationId);
    const { providerId } =
      existing ?? (await this.providers.register({ adminUserId: input.adminUserId, organizationId, type: input.type, displayName: input.displayName.trim() }));
    await this.providers.activate({ actorUserId: input.actorUserId, providerId });

    await this.audit.record({
      actorUserId: input.actorUserId,
      action: 'PROVIDER_REGISTERED_BY_ADMIN',
      resourceType: 'HealthcareProvider',
      resourceId: providerId,
      context: { organizationId, adminUserId: input.adminUserId, type: input.type, licenseNumber: input.licenseNumber.trim(), documentCount: input.documents.length },
      ip: input.ip,
    });
    return { organizationId, providerId, adminUserId: input.adminUserId };
  }

  list(filter: { q?: string; type?: ProviderType; status?: ProviderStatus }, page: number, size: number) {
    return this.reads.list(filter, page, size);
  }

  /** The provider's record with who it is in Module 01: its organisation, licence, administrator and staff. */
  async get(providerId: string): Promise<ProviderRecord & { organization: Awaited<ReturnType<IIdentityOrganizationReadPort['getOrganizationPeople']>> }> {
    const record = await this.reads.get(providerId);
    if (!record) throw new ApiException(ErrorCode.PROVIDER_NOT_FOUND, 'Healthcare provider not found.');
    return { ...record, organization: await this.organizations.getOrganizationPeople(record.organizationId) };
  }

  async suspend(input: { actorUserId: string; providerId: string; reason: string }) {
    return { suspended: await this.providers.suspend(input) };
  }

  async reactivate(input: { actorUserId: string; providerId: string }) {
    return { reactivated: await this.providers.reactivate(input) };
  }
}
