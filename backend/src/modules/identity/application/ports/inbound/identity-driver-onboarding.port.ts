import { Injectable } from '@nestjs/common';
import type { SignedUrl } from '../../../../../shared/storage/document-storage.port';
import { VerificationType } from '../../../domain/enums';
import { ApproveVerificationCommand } from '../../commands/approve-verification.command';
import { MakeDriverCommand } from '../../commands/make-driver.command';
import { RequestDocumentUploadCommand } from '../../commands/request-document-upload.command';
import { SubmitVerificationDocumentsCommand } from '../../commands/submit-verification-documents.command';

export const IDENTITY_DRIVER_ONBOARDING_PORT = Symbol('IDENTITY_DRIVER_ONBOARDING_PORT');

export interface DriverDocument {
  /** e.g. `DRIVING_LICENSE`, `VEHICLE_REGISTRATION`, `NATIONAL_ID`. */
  kind: string;
  /** A `doc:` reference returned by `requestDriverDocumentUpload` for this person. */
  storageRef: string;
}

/**
 * Work 156: Module 01's steps of registering a driver, run by a platform administrator. Each is
 * the command the rest of Module 01 uses: the account becomes a driver (`MakeDriverCommand`), its
 * documents are stored under it and submitted as DRIVER_DOCS, and the administrator approves them
 * with an expiry — which is what delivery checks before a driver may go online.
 */
export interface IIdentityDriverOnboardingPort {
  makeDriver(input: { userId: string; actorUserId: string; ip: string | null }): Promise<{ changed: boolean }>;
  requestDriverDocumentUpload(input: { userId: string; contentType: string; bytes: number; ip: string | null }): Promise<{ storageRef: string; upload: SignedUrl }>;
  submitDriverDocuments(input: { userId: string; documents: DriverDocument[]; ip: string | null }): Promise<{ requestId: string; status: string }>;
  approveDriverDocuments(input: { requestId: string; reviewerId: string; expiresAt: Date; ip: string | null }): Promise<void>;
}

@Injectable()
export class IdentityDriverOnboardingAdapter implements IIdentityDriverOnboardingPort {
  constructor(
    private readonly make: MakeDriverCommand,
    private readonly upload: RequestDocumentUploadCommand,
    private readonly submit: SubmitVerificationDocumentsCommand,
    private readonly approve: ApproveVerificationCommand,
  ) {}

  makeDriver(input: { userId: string; actorUserId: string; ip: string | null }) {
    return this.make.execute(input);
  }

  requestDriverDocumentUpload(input: { userId: string; contentType: string; bytes: number; ip: string | null }) {
    return this.upload.execute(input);
  }

  async submitDriverDocuments(input: { userId: string; documents: DriverDocument[]; ip: string | null }) {
    const result = await this.submit.execute({
      userId: input.userId,
      type: VerificationType.DRIVER_DOCS,
      documents: input.documents.map((d) => ({ kind: d.kind, storageRef: d.storageRef })),
      ip: input.ip,
    });
    return { requestId: result.requestId, status: result.status };
  }

  async approveDriverDocuments(input: { requestId: string; reviewerId: string; expiresAt: Date; ip: string | null }) {
    await this.approve.execute({ requestId: input.requestId, reviewerId: input.reviewerId, expiresAt: input.expiresAt, ip: input.ip });
  }
}
