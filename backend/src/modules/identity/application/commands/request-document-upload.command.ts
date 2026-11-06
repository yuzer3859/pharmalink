import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { AuditService } from '../../../../shared/audit/audit.service';
import { ApiException } from '../../../../shared/errors/api-exception';
import { ErrorCode } from '../../../../shared/errors/error-codes';
import {
  ALLOWED_DOCUMENT_CONTENT_TYPES,
  documentRef,
  DOCUMENT_STORAGE_PORT,
  IDocumentStoragePort,
  MAX_DOCUMENT_BYTES,
  parseDocumentRef,
  SignedUrl,
  UPLOAD_URL_TTL_SECONDS,
} from '../../../../shared/storage/document-storage.port';
import { IdentityErrors } from '../../domain/errors';

export interface RequestDocumentUploadInput {
  userId: string;
  contentType: string;
  bytes: number;
  ip?: string | null;
}

export interface RequestDocumentUploadResult {
  /** What `POST /verification/documents` takes once the file is uploaded. */
  storageRef: string;
  upload: SignedUrl;
}

/**
 * A signed upload link for one verification document (Work 89, backend/docs/document-storage.md).
 * The client PUTs the file straight to storage; the API never sees the bytes. The link is bound to
 * the content type and exact length, and the reference to the caller.
 */
@Injectable()
export class RequestDocumentUploadCommand {
  constructor(
    @Inject(DOCUMENT_STORAGE_PORT) private readonly storage: IDocumentStoragePort,
    private readonly audit: AuditService,
  ) {}

  async execute(input: RequestDocumentUploadInput): Promise<RequestDocumentUploadResult> {
    if (!(ALLOWED_DOCUMENT_CONTENT_TYPES as readonly string[]).includes(input.contentType)) {
      throw IdentityErrors.validation(`A document must be one of ${ALLOWED_DOCUMENT_CONTENT_TYPES.join(', ')}.`);
    }
    if (!Number.isInteger(input.bytes) || input.bytes < 1 || input.bytes > MAX_DOCUMENT_BYTES) {
      throw IdentityErrors.validation(`A document must be between 1 byte and ${MAX_DOCUMENT_BYTES} bytes.`);
    }
    if (!this.storage.available) {
      throw new ApiException(ErrorCode.DEPENDENCY_UNAVAILABLE, 'Document uploads are not available.');
    }
    const storageRef = documentRef('verification', input.userId, randomUUID());
    const upload = await this.storage.signUpload(parseDocumentRef(storageRef)!, input.contentType, input.bytes, UPLOAD_URL_TTL_SECONDS);
    await this.audit.record({
      actorUserId: input.userId,
      action: 'identity.verification.document_upload_issued',
      resourceType: 'verification_document',
      resourceId: storageRef,
      context: { contentType: input.contentType, bytes: input.bytes },
      ip: input.ip ?? null,
    });
    return { storageRef, upload };
  }
}
