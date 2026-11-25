import { Injectable } from '@nestjs/common';
import type { SignedUrl } from '../../../../../shared/storage/document-storage.port';
import { VerificationType } from '../../../domain/enums';
import { ApplyFacilityOrganizationCommand, type FacilityOrganizationType } from '../../commands/apply-facility-organization.command';
import { ApproveVerificationCommand } from '../../commands/approve-verification.command';
import { RequestDocumentUploadCommand } from '../../commands/request-document-upload.command';
import { SubmitVerificationDocumentsCommand } from '../../commands/submit-verification-documents.command';
import type { OwnerLicenceDocument } from './identity-pharmacy-onboarding.port';

export const IDENTITY_FACILITY_ONBOARDING_PORT = Symbol('IDENTITY_FACILITY_ONBOARDING_PORT');

/**
 * Work 160: Module 01's steps of registering a hospital, clinic or lab, run by a platform
 * administrator on the facility administrator's behalf — the facility twin of Work 154's
 * pharmacy onboarding port. Each delegates to the command the facility's own flow would use.
 */
export interface IIdentityFacilityOnboardingPort {
  /** `ApplyFacilityOrganizationCommand` as the administrator-to-be; the same key returns the same organisation. */
  applyOrganization(input: {
    adminUserId: string;
    type: FacilityOrganizationType;
    legalName: string;
    idempotencyKey: string;
    ip: string | null;
  }): Promise<{ organizationId: string; status: string }>;
  /** A signed upload for one licence file, stored under the facility administrator. */
  requestAdminDocumentUpload(input: { adminUserId: string; contentType: string; bytes: number; ip: string | null }): Promise<{ storageRef: string; upload: SignedUrl }>;
  /** `SubmitVerificationDocumentsCommand` (FACILITY_LICENSE) as the administrator, for the organisation. */
  submitLicence(input: { adminUserId: string; organizationId: string; documents: OwnerLicenceDocument[]; ip: string | null }): Promise<{ requestId: string; status: string }>;
  /** `ApproveVerificationCommand` with the platform administrator as reviewer. */
  approveLicence(input: { requestId: string; reviewerId: string; licenseNumber: string; expiresAt: Date; ip: string | null }): Promise<void>;
}

@Injectable()
export class IdentityFacilityOnboardingAdapter implements IIdentityFacilityOnboardingPort {
  constructor(
    private readonly apply: ApplyFacilityOrganizationCommand,
    private readonly upload: RequestDocumentUploadCommand,
    private readonly submit: SubmitVerificationDocumentsCommand,
    private readonly approve: ApproveVerificationCommand,
  ) {}

  async applyOrganization(input: { adminUserId: string; type: FacilityOrganizationType; legalName: string; idempotencyKey: string; ip: string | null }) {
    const view = await this.apply.execute({
      actorUserId: input.adminUserId,
      type: input.type,
      legalName: input.legalName,
      idempotencyKey: input.idempotencyKey,
      ip: input.ip,
    });
    return { organizationId: view.organizationId, status: view.status };
  }

  requestAdminDocumentUpload(input: { adminUserId: string; contentType: string; bytes: number; ip: string | null }) {
    return this.upload.execute({ userId: input.adminUserId, contentType: input.contentType, bytes: input.bytes, ip: input.ip });
  }

  async submitLicence(input: { adminUserId: string; organizationId: string; documents: OwnerLicenceDocument[]; ip: string | null }) {
    const result = await this.submit.execute({
      userId: input.adminUserId,
      type: VerificationType.FACILITY_LICENSE,
      organizationId: input.organizationId,
      documents: input.documents.map((d) => ({ kind: d.kind, storageRef: d.storageRef })),
      ip: input.ip,
    });
    return { requestId: result.requestId, status: result.status };
  }

  async approveLicence(input: { requestId: string; reviewerId: string; licenseNumber: string; expiresAt: Date; ip: string | null }) {
    await this.approve.execute({ requestId: input.requestId, reviewerId: input.reviewerId, licenseNumber: input.licenseNumber, expiresAt: input.expiresAt, ip: input.ip });
  }
}
