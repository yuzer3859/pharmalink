import { randomUUID } from 'crypto';
import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../../../shared/audit/audit.service';
import { ApiException } from '../../../../shared/errors/api-exception';
import { ErrorCode } from '../../../../shared/errors/error-codes';
import {
  ALLOWED_DOCUMENT_CONTENT_TYPES,
  DOC_REF_PREFIX,
  documentRef,
  DOCUMENT_STORAGE_PORT,
  IDocumentStoragePort,
  MAX_DOCUMENT_BYTES,
  parseDocumentRef,
  PREVIEW_URL_TTL_SECONDS,
  SignedUrl,
  UPLOAD_URL_TTL_SECONDS,
} from '../../../../shared/storage/document-storage.port';
import { PrescriptionAccessType } from '../../domain/enums';
import { PrescriptionMatchingErrors } from '../../domain/errors';
import { GetPrescriptionQuery } from '../queries/get-prescription.query';

/** The storage namespace for prescription files: `doc:prescription/<customerUserId>/<uuid>`. */
export const PRESCRIPTION_FILE_NAMESPACE = 'prescription';

export interface PrescriptionUploadLink {
  fileRef: string;
  upload: SignedUrl;
}

/**
 * Work 101: a prescription's file in the platform's document storage (Phase 1 audit G7). Before
 * this, `POST /prescriptions` took any client string as `fileRef`; no file was stored and a
 * pharmacist had nothing to open.
 *
 *  - `requestUpload`: the customer gets a short-lived signed upload link for their own file
 *    (pdf, jpeg or png, at most 10 MiB), keyed under their user id.
 *  - `assertUsable`: before an upload or re-upload is recorded, a `doc:` reference must be the
 *    caller's own, already stored, of the declared type and size. A reference from before Work 101
 *    (not `doc:`) is still accepted, as Work 89 did for verification documents; it simply cannot be
 *    previewed.
 *  - `previewLink`: the owner or the reviewing pharmacist (or an admin) gets a 5-minute read link,
 *    through the prescription's own access policy and access log (`DOWNLOAD`), and audited.
 */
@Injectable()
export class PrescriptionFileService {
  constructor(
    @Inject(DOCUMENT_STORAGE_PORT) private readonly storage: IDocumentStoragePort,
    private readonly getPrescription: GetPrescriptionQuery,
    private readonly audit: AuditService,
  ) {}

  async requestUpload(input: { userId: string; contentType: string; bytes: number; ip?: string | null }): Promise<PrescriptionUploadLink> {
    if (!(ALLOWED_DOCUMENT_CONTENT_TYPES as readonly string[]).includes(input.contentType)) {
      throw PrescriptionMatchingErrors.validation(`A prescription file must be one of ${ALLOWED_DOCUMENT_CONTENT_TYPES.join(', ')}.`, { field: 'contentType' });
    }
    if (!Number.isInteger(input.bytes) || input.bytes < 1 || input.bytes > MAX_DOCUMENT_BYTES) {
      throw PrescriptionMatchingErrors.validation(`A prescription file must be between 1 byte and ${MAX_DOCUMENT_BYTES} bytes.`, { field: 'bytes' });
    }
    if (!this.storage.available) {
      throw new ApiException(ErrorCode.DEPENDENCY_UNAVAILABLE, 'Prescription uploads are not available.');
    }
    const fileRef = documentRef(PRESCRIPTION_FILE_NAMESPACE, input.userId, randomUUID());
    const upload = await this.storage.signUpload(parseDocumentRef(fileRef)!, input.contentType, input.bytes, UPLOAD_URL_TTL_SECONDS);
    await this.audit.record({
      actorUserId: input.userId,
      action: 'PRESCRIPTION_UPLOAD_ISSUED',
      resourceType: 'PrescriptionFile',
      resourceId: fileRef,
      context: { contentType: input.contentType, bytes: input.bytes },
      ip: input.ip ?? null,
    });
    return { fileRef, upload };
  }

  async assertUsable(userId: string, fileRef: string, fileType: string): Promise<void> {
    if (!fileRef.startsWith(DOC_REF_PREFIX)) return;
    const ref = parseDocumentRef(fileRef);
    if (!ref || ref.namespace !== PRESCRIPTION_FILE_NAMESPACE || ref.ownerId !== userId) {
      throw PrescriptionMatchingErrors.validation('The prescription file is not one of your uploads.', { field: 'fileRef' });
    }
    if (!this.storage.available) throw new ApiException(ErrorCode.DEPENDENCY_UNAVAILABLE, 'Prescription uploads are not available.');
    const info = await this.storage.describe(ref);
    if (!info) throw new ApiException(ErrorCode.DOCUMENT_NOT_STORED, 'The prescription file has not been uploaded yet.', { fileRef });
    if (info.contentType !== fileType || info.bytes === 0 || info.bytes > MAX_DOCUMENT_BYTES) {
      throw PrescriptionMatchingErrors.validation('The uploaded file does not match the declared type or size.', { field: 'fileType' });
    }
  }

  async previewLink(input: { prescriptionId: string; userId: string; isAdmin?: boolean; ip?: string | null }): Promise<{ url: string; expiresAt: string; contentType: string }> {
    // The prescription's own policy decides (owner, reviewing pharmacist, admin) and logs the access.
    const prescription = await this.getPrescription.execute({
      prescriptionId: input.prescriptionId,
      requestingUserId: input.userId,
      isAdmin: input.isAdmin,
      accessType: PrescriptionAccessType.DOWNLOAD,
    });
    const ref = prescription.fileRef ? parseDocumentRef(prescription.fileRef) : null;
    const info = ref ? await this.storage.describe(ref) : null;
    if (!ref || !info) {
      throw new ApiException(ErrorCode.DOCUMENT_NOT_STORED, 'This prescription has no stored file to open.', { prescriptionId: prescription.id });
    }
    const link = await this.storage.signRead(ref, info.contentType, PREVIEW_URL_TTL_SECONDS);
    await this.audit.record({
      actorUserId: input.userId,
      action: 'PRESCRIPTION_FILE_PREVIEWED',
      resourceType: 'Prescription',
      resourceId: prescription.id,
      context: { contentType: info.contentType },
      ip: input.ip ?? null,
    });
    return { url: link.url, expiresAt: link.expiresAt.toISOString(), contentType: info.contentType };
  }
}
