import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../../../shared/audit/audit.service';
import { VerificationDocument } from '../../domain/entities/verification-request.entity';
import { VerificationType } from '../../domain/enums';
import {
  IVerificationRepository,
  VERIFICATION_REPOSITORY,
} from '../../domain/repositories/verification.repository';

export interface SubmitVerificationDocumentsInput {
  userId: string;
  type: VerificationType;
  organizationId?: string | null;
  documents: VerificationDocument[];
  ip?: string | null;
}

export interface SubmitVerificationDocumentsResult {
  requestId: string;
  status: string;
  documentCount: number;
}

/**
 * POST /verification/documents (module-01 §9.2 step 3, §11.6). Accepts references to objects
 * already uploaded to encrypted storage — the bytes never pass through this service. Documents
 * attach to the caller's open request of that type, or open one if none exists, so a provider can
 * upload paperwork across several calls without creating duplicate queue entries.
 */
@Injectable()
export class SubmitVerificationDocumentsCommand {
  constructor(
    @Inject(VERIFICATION_REPOSITORY) private readonly verifications: IVerificationRepository,
    private readonly audit: AuditService,
  ) {}

  async execute(
    input: SubmitVerificationDocumentsInput,
  ): Promise<SubmitVerificationDocumentsResult> {
    const existing = await this.verifications.findPendingForUser(input.userId, input.type);

    const request =
      existing ??
      (await this.verifications.create({
        userId: input.userId,
        organizationId: input.organizationId ?? null,
        type: input.type,
        faydaIdEncrypted: null,
        documents: [],
      }));

    request.attachDocuments(input.documents);
    await this.verifications.save(request);

    await this.audit.record({
      actorUserId: input.userId,
      action: 'identity.verification.documents_attached',
      resourceType: 'verification_request',
      resourceId: request.id,
      context: { type: input.type, kinds: input.documents.map((d) => d.kind) },
      ip: input.ip ?? null,
    });

    return {
      requestId: request.id,
      status: request.status,
      documentCount: request.documents.length,
    };
  }
}
