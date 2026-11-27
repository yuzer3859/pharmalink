import { Injectable } from '@nestjs/common';
import type { SignedUrl } from '../../../../../shared/storage/document-storage.port';
import { VerificationType } from '../../../domain/enums';
import { ApproveVerificationCommand } from '../../commands/approve-verification.command';
import { MakeDoctorCommand } from '../../commands/make-doctor.command';
import { RequestDocumentUploadCommand } from '../../commands/request-document-upload.command';
import { SubmitVerificationDocumentsCommand } from '../../commands/submit-verification-documents.command';

export const IDENTITY_DOCTOR_ONBOARDING_PORT = Symbol('IDENTITY_DOCTOR_ONBOARDING_PORT');

export interface DoctorDocument {
  /** e.g. `MEDICAL_LICENSE`, `DEGREE_CERTIFICATE`, `NATIONAL_ID`. */
  kind: string;
  /** A `doc:` reference returned by `requestDoctorDocumentUpload` for this person. */
  storageRef: string;
}

/**
 * Work 166: Module 01's steps of registering a doctor, run by a platform administrator — the
 * doctor twin of Work 156's driver port. The account becomes a doctor (`MakeDoctorCommand`), the
 * medical licence and certificates are stored under it and submitted as DOCTOR_LICENSE, and the
 * administrator approves them with the licence's expiry. When that expires, Module 01 suspends
 * the account and announces `identity.license.expired`.
 */
export interface IIdentityDoctorOnboardingPort {
  makeDoctor(input: { userId: string; actorUserId: string; ip: string | null }): Promise<{ changed: boolean }>;
  requestDoctorDocumentUpload(input: { userId: string; contentType: string; bytes: number; ip: string | null }): Promise<{ storageRef: string; upload: SignedUrl }>;
  submitDoctorLicence(input: { userId: string; documents: DoctorDocument[]; ip: string | null }): Promise<{ requestId: string; status: string }>;
  approveDoctorLicence(input: { requestId: string; reviewerId: string; expiresAt: Date; ip: string | null }): Promise<void>;
}

@Injectable()
export class IdentityDoctorOnboardingAdapter implements IIdentityDoctorOnboardingPort {
  constructor(
    private readonly make: MakeDoctorCommand,
    private readonly upload: RequestDocumentUploadCommand,
    private readonly submit: SubmitVerificationDocumentsCommand,
    private readonly approve: ApproveVerificationCommand,
  ) {}

  makeDoctor(input: { userId: string; actorUserId: string; ip: string | null }) {
    return this.make.execute(input);
  }

  requestDoctorDocumentUpload(input: { userId: string; contentType: string; bytes: number; ip: string | null }) {
    return this.upload.execute(input);
  }

  async submitDoctorLicence(input: { userId: string; documents: DoctorDocument[]; ip: string | null }) {
    const result = await this.submit.execute({
      userId: input.userId,
      type: VerificationType.DOCTOR_LICENSE,
      documents: input.documents.map((d) => ({ kind: d.kind, storageRef: d.storageRef })),
      ip: input.ip,
    });
    return { requestId: result.requestId, status: result.status };
  }

  async approveDoctorLicence(input: { requestId: string; reviewerId: string; expiresAt: Date; ip: string | null }) {
    await this.approve.execute({ requestId: input.requestId, reviewerId: input.reviewerId, expiresAt: input.expiresAt, ip: input.ip });
  }
}
