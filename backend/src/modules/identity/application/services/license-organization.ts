import { VerificationRequest } from '../../domain/entities/verification-request.entity';
import { IdentityErrors } from '../../domain/errors';
import {
  IOrganizationRepository,
  OrganizationRecord,
} from '../../domain/repositories/organization.repository';

/**
 * The organisation a PHARMACY_LICENSE request is for (Work 67): it must exist, be undeleted, be a
 * PHARMACY, and be owned by the request's subject. Anything else refuses the decision outright,
 * so a licence is never approved or rejected against the wrong organisation.
 */
export async function resolveLicenseOrganization(
  organizations: IOrganizationRepository,
  request: VerificationRequest,
): Promise<OrganizationRecord> {
  if (!request.organizationId) {
    throw IdentityErrors.licenseOrganizationMismatch('ORGANIZATION_MISSING');
  }
  const organization = await organizations.findById(request.organizationId);
  if (!organization || organization.deletedAt) {
    throw IdentityErrors.licenseOrganizationMismatch('ORGANIZATION_NOT_FOUND');
  }
  if (organization.type !== 'PHARMACY') {
    throw IdentityErrors.licenseOrganizationMismatch('ORGANIZATION_NOT_PHARMACY');
  }
  if (organization.ownerUserId !== request.userId) {
    throw IdentityErrors.licenseOrganizationMismatch('OWNER_MISMATCH');
  }
  return organization;
}
