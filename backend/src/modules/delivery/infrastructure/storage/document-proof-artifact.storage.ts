import { createHash, randomUUID } from 'crypto';
import {
  documentRef,
  IDocumentStoragePort,
  parseDocumentRef,
  PREVIEW_URL_TTL_SECONDS,
} from '../../../../shared/storage/document-storage.port';
import {
  IProofArtifactStoragePort,
  ProofArtifactUpload,
  StoredProofArtifact,
} from '../../application/ports/outbound/proof-artifact-storage.port';

/** The storage namespace for proof-of-delivery artifacts: `doc:pod/<jobId>/<uuid>`. */
export const POD_ARTIFACT_NAMESPACE = 'pod';

/**
 * Work 102 (Phase 1 audit G13): proof-of-delivery signatures and photographs in the platform's
 * document storage (Work 89: MinIO on staging, S3-compatible in production), instead of process
 * memory that a restart loses. The `proof_of_delivery` row stays the record of what was captured
 * (type, size, SHA-256); storage only holds the bytes, so `describe` reports availability, not
 * the digest.
 */
export class DocumentStorageProofArtifacts implements IProofArtifactStoragePort {
  constructor(private readonly storage: IDocumentStoragePort) {}

  async store(upload: ProofArtifactUpload): Promise<StoredProofArtifact> {
    const ref = documentRef(POD_ARTIFACT_NAMESPACE, upload.jobId, randomUUID());
    const parsed = parseDocumentRef(ref);
    if (!parsed) throw new Error('A proof-of-delivery artifact needs a delivery job id.');
    await this.storage.put(parsed, upload.contentType, upload.content);
    return {
      ref,
      contentType: upload.contentType,
      bytes: upload.content.length,
      sha256: createHash('sha256').update(upload.content).digest('hex'),
    };
  }

  async describe(ref: string): Promise<Omit<StoredProofArtifact, 'ref'> | null> {
    const parsed = parseDocumentRef(ref);
    if (!parsed) return null;
    const info = await this.storage.describe(parsed);
    return info ? { contentType: info.contentType, bytes: info.bytes, sha256: '' } : null;
  }

  async readUrl(ref: string): Promise<{ url: string; expiresAt: Date } | null> {
    const parsed = parseDocumentRef(ref);
    if (!parsed) return null;
    const info = await this.storage.describe(parsed);
    if (!info) return null;
    const link = await this.storage.signRead(parsed, info.contentType, PREVIEW_URL_TTL_SECONDS);
    return { url: link.url, expiresAt: link.expiresAt };
  }
}
