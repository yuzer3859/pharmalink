import { createHash } from 'crypto';
import { Injectable } from '@nestjs/common';
import {
  IProofArtifactStoragePort,
  ProofArtifactUpload,
  StoredProofArtifact,
} from '../../application/ports/outbound/proof-artifact-storage.port';

/** The handle's namespace, so a reference is self-describing in a log or a database row. */
const REF_PREFIX = 'pod';

/**
 * How many artifacts one process will hold before it starts discarding the oldest.
 *
 * A cap because this is a process-memory store and an uncapped one in a long-lived API node is a
 * slow leak. It is also a reminder of what this adapter is: evidence that can be evicted is not
 * evidence, which is why the class comment below is explicit that enabling artifact-backed proof in
 * production means replacing this first.
 */
const CAPACITY = 500;

/**
 * `IProofArtifactStoragePort` with no storage provider behind it (§10's `IStoragePort (PoD)`).
 *
 * ## Why this exists, and what it is not
 *
 * The platform has **no approved object-storage provider**. Module 01 has been waiting for one
 * too — its `VerificationRequest.documents[].storageRef` is documented as a handle into encrypted
 * object storage that no adapter in this repository actually writes to — and choosing one is a
 * procurement and security decision involving credentials, retention, encryption at rest and a
 * data-residency question that a delivery module is in no position to settle. Adding S3 or
 * Cloudinary to satisfy a task would be committing the platform to a vendor by side effect.
 *
 * So this is the deterministic, in-process stand-in the brief asks for, in the same tradition as
 * `MockPaymentProvider`, `HaversineRoutingAdapter`, the in-memory OTP store and the mock Fayda
 * provider: **no network I/O, no credentials, no configuration**. It makes the whole PoD path real
 * and exercisable end to end, and it makes the storage seam concrete so that the work which does
 * choose a provider changes one file.
 *
 * **It must not back artifact-required proof in production, and the default configuration ensures
 * it does not.** `delivery.podRequirement` defaults to `NONE`, so nothing on the platform demands
 * a signature or a photograph; a deployment that raises it to `ARTIFACT` is asserting that
 * evidence will be kept, and this adapter cannot keep it — memory does not survive a restart and
 * entries are evicted under pressure. Turning on artifact-backed proof and choosing a storage
 * provider are the same decision, and that is by design rather than by accident.
 *
 * ## Content addressing
 *
 * The handle is derived from the SHA-256 of the bytes, which makes the adapter idempotent for
 * free: storing the same signature twice writes one entry and yields one handle. That matters more
 * than it looks. A handset retrying a submission after a timeout would otherwise leave an orphaned
 * copy on every attempt, and the capture command deliberately stores *before* opening its
 * transaction — content addressing is what keeps that ordering from accumulating garbage.
 *
 * It also makes tests exact: the same fixture always produces the same reference, so an assertion
 * can name it.
 */
@Injectable()
export class InMemoryProofArtifactStorage implements IProofArtifactStoragePort {
  private readonly artifacts = new Map<string, StoredProofArtifact & { content: Buffer }>();

  async store(upload: ProofArtifactUpload): Promise<StoredProofArtifact> {
    const sha256 = createHash('sha256').update(upload.content).digest('hex');
    // The job scopes the handle so one delivery's evidence can never be addressed through another
    // delivery's reference, even though the digest alone would be unique. A real adapter should
    // namespace its object keys the same way.
    const ref = `${REF_PREFIX}/${upload.jobId}/${sha256}`;

    const descriptor: StoredProofArtifact = {
      ref,
      contentType: upload.contentType,
      bytes: upload.content.length,
      sha256,
    };

    if (!this.artifacts.has(ref)) {
      if (this.artifacts.size >= CAPACITY) {
        this.evictOldest();
      }
      // Copied rather than retained: the caller's buffer came from a request body and must not
      // stay reachable from here once that request is over.
      this.artifacts.set(ref, { ...descriptor, content: Buffer.from(upload.content) });
    }

    return descriptor;
  }

  async describe(ref: string): Promise<Omit<StoredProofArtifact, 'ref'> | null> {
    const stored = this.artifacts.get(ref);
    if (!stored) {
      return null;
    }
    // Metadata only. The content is deliberately not reachable through the port — see the port's
    // comment on why there is no `readContent` and no signed-URL method.
    return { contentType: stored.contentType, bytes: stored.bytes, sha256: stored.sha256 };
  }

  private evictOldest(): void {
    const oldest = this.artifacts.keys().next();
    if (!oldest.done) {
      this.artifacts.delete(oldest.value);
    }
  }
}
