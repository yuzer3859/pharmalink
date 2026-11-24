import { Injectable } from '@nestjs/common';
import type { SignedUrl } from '../../../../../shared/storage/document-storage.port';
import { VerificationType } from '../../../domain/enums';
import { ApplyPharmacyOrganizationCommand } from '../../commands/apply-pharmacy-organization.command';
import { ApproveVerificationCommand } from '../../commands/approve-verification.command';
import { RequestDocumentUploadCommand } from '../../commands/request-document-upload.command';
import { SubmitVerificationDocumentsCommand } from '../../commands/submit-verification-documents.command';

export const IDENTITY_PHARMACY_ONBOARDING_PORT = Symbol('IDENTITY_PHARMACY_ONBOARDING_PORT');

export interface OwnerLicenceDocument {
  /** e.g. `BUSINESS_LICENSE`, `PHARMACIST_LICENSE`. */
  kind: string;
  /** A `doc:` reference returned by `requestOwnerDocumentUpload` for this owner. */
  storageRef: string;
}

/**
 * Work 154: Module 01's steps of registering a pharmacy, run by a platform administrator on an
 * owner's behalf. Each delegates to the command the owner's own flow uses, with every rule it
 * applies: the owner must be an active, e-mail-verified account; uploads are stored under the
 * owner and only theirs may be submitted; the licence approval records the administrator as the
 * reviewer and makes the organisation ACTIVE with its licence.
 */
export interface IIdentityPharmacyOnboardingPort {
  /** `ApplyPharmacyOrganizationCommand` as the owner; the same key returns the same organisation. */
  applyOrganization(input: { ownerUserId: string; legalName: string; idempotencyKey: string; ip: string | null }): Promise<{ organizationId: string; status: string }>;
  /** A signed upload for one licence file, stored under the owner (`RequestDocumentUploadCommand`). */
  requestOwnerDocumentUpload(input: { ownerUserId: string; contentType: string; bytes: number; ip: string | null }): Promise<{ storageRef: string; upload: SignedUrl }>;
  /** `SubmitVerificationDocumentsCommand` (PHARMACY_LICENSE) as the owner, for the organisation. */
  submitLicence(input: { ownerUserId: string; organizationId: string; documents: OwnerLicenceDocument[]; ip: string | null }): Promise<{ requestId: string; status: string }>;
  /** `ApproveVerificationCommand` with the administrator as reviewer. */
  approveLicence(input: { requestId: string; reviewerId: string; licenseNumber: string; expiresAt: Date; ip: string | null }): Promise<void>;
}

@Injectable()
export class IdentityPharmacyOnboardingAdapter implements IIdentityPharmacyOnboardingPort {
  constructor(
    private readonly apply: ApplyPharmacyOrganizationCommand,
    private readonly upload: RequestDocumentUploadCommand,
    private readonly submit: SubmitVerificationDocumentsCommand,
    private readonly approve: ApproveVerificationCommand,
  ) {}

  async applyOrganization(input: { ownerUserId: string; legalName: string; idempotencyKey: string; ip: string | null }) {
    const view = await this.apply.execute({ actorUserId: input.ownerUserId, legalName: input.legalName, idempotencyKey: input.idempotencyKey, ip: input.ip });
    return { organizationId: view.organizationId, status: view.status };
  }

  requestOwnerDocumentUpload(input: { ownerUserId: string; contentType: string; bytes: number; ip: string | null }) {
    return this.upload.execute({ userId: input.ownerUserId, contentType: input.contentType, bytes: input.bytes, ip: input.ip });
  }

  async submitLicence(input: { ownerUserId: string; organizationId: string; documents: OwnerLicenceDocument[]; ip: string | null }) {
    const result = await this.submit.execute({
      userId: input.ownerUserId,
      type: VerificationType.PHARMACY_LICENSE,
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
