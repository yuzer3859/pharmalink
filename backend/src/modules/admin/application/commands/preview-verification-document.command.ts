import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../../../shared/audit/audit.service';
import { ApiException } from '../../../../shared/errors/api-exception';
import { ErrorCode } from '../../../../shared/errors/error-codes';
import {
  DOCUMENT_STORAGE_PORT,
  IDocumentStoragePort,
  parseDocumentRef,
  PREVIEW_URL_TTL_SECONDS,
} from '../../../../shared/storage/document-storage.port';
import {
  IDENTITY_ADMIN_PORT,
  IIdentityAdminPort,
} from '../../../identity/application/ports/inbound/identity-admin.port';

export interface DocumentPreview {
  kind: string;
  contentType: string;
  url: string;
  expiresAt: Date;
}

/**
 * Document preview in the verification review (Work 89, module-16 §9.1, backend/docs/document-storage.md).
 *
 * A reviewer gets a signed link, valid five minutes, to one document of one request. The link is a
 * credential to someone's licence or ID, so every one issued is audited
 * (`VERIFICATION_DOCUMENT_PREVIEWED`: who, which request, which document) — the "purpose-bound and
 * logged" access to sensitive data module-16 §13 asks for. Admin never reads the bytes.
 */
@Injectable()
export class PreviewVerificationDocumentCommand {
  constructor(
    @Inject(IDENTITY_ADMIN_PORT) private readonly identity: IIdentityAdminPort,
    @Inject(DOCUMENT_STORAGE_PORT) private readonly storage: IDocumentStoragePort,
    private readonly audit: AuditService,
  ) {}

  async execute(input: { requestId: string; index: number; reviewerId: string; ip?: string | null }): Promise<DocumentPreview> {
    const request = await this.identity.getVerificationRequest(input.requestId);
    const document = request?.documents[input.index];
    if (!request || !document) throw ApiException.notFound('Verification document not found');
    const ref = parseDocumentRef(document.storageRef);
    if (!ref) {
      throw new ApiException(ErrorCode.DOCUMENT_NOT_STORED, 'This document was submitted as a reference only; there is no file to preview.');
    }
    if (!this.storage.available) throw new ApiException(ErrorCode.DEPENDENCY_UNAVAILABLE, 'Document storage is not available.');
    const info = await this.storage.describe(ref);
    if (!info) throw new ApiException(ErrorCode.DOCUMENT_NOT_STORED, 'The file for this document is missing from storage.');
    const link = await this.storage.signRead(ref, info.contentType, PREVIEW_URL_TTL_SECONDS);
    await this.audit.record({
      actorUserId: input.reviewerId,
      action: 'VERIFICATION_DOCUMENT_PREVIEWED',
      resourceType: 'verification_request',
      resourceId: input.requestId,
      context: { index: input.index, kind: document.kind, contentType: info.contentType, ttlSeconds: PREVIEW_URL_TTL_SECONDS },
      ip: input.ip ?? null,
    });
    return { kind: document.kind, contentType: info.contentType, url: link.url, expiresAt: link.expiresAt };
  }
}
