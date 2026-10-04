export const PROOF_ARTIFACT_STORAGE_PORT = Symbol('DELIVERY_PROOF_ARTIFACT_STORAGE_PORT');

/** Bytes on their way to storage, with the content type the caller claims for them. */
export interface ProofArtifactUpload {
  /** The delivery this artifact belongs to, so an implementation can namespace by job. */
  jobId: string;
  contentType: string;
  content: Buffer;
}

/** Where the bytes went, and what they were. */
export interface StoredProofArtifact {
  /**
   * Opaque handle. **Not a URL**, and nothing may treat it as one.
   *
   * Module 01's `VerificationRequest.documents[].storageRef` established this shape — "opaque
   * reference into encrypted object storage — never the document bytes themselves" — and the same
   * reasoning applies with more force here: a delivery photo shows somebody's front door. A
   * reference that were a URL would be a credential the moment it appeared in a response body, a
   * log line or a customer's browser history.
   */
  ref: string;
  contentType: string;
  bytes: number;
  /** Hex SHA-256 of the stored content. */
  sha256: string;
}

/**
 * Storage for proof-of-delivery artifacts (§10's `IStoragePort (PoD)`).
 *
 * ## The vendor stops here
 *
 * Nothing in the domain or application layer may know where an artifact physically lives — S3, a
 * local volume, an encrypted bucket, a process's memory. Bytes in, an opaque handle out. That is
 * the same discipline `IRoutingPort` applies to map providers, and it exists for the same reason:
 * the platform has no approved storage provider, so the one thing this work must not do is commit
 * to one by accident.
 *
 * There is deliberately **no `getPublicUrl`, no `getSignedUrl` and no `readContent`** on this
 * port. A presigned-URL method would be the natural place for the next work to start handing
 * delivery photographs to browsers, and the decision to do that — who may receive one, for how
 * long, and audited how — is not one this work is in a position to make. `describe` answers what
 * the read path actually needs: does this evidence still exist, and what is it. Serving the bytes
 * is a separate capability that arrives with the provider and the access policy together.
 *
 * ## Failure is an exception here, unlike the module's other outbound ports
 *
 * `IRoutingPort` and `IRealtimePort` answer `null`/`false` on failure because their results are
 * optional — a delivery without an ETA is a working delivery. Storage is not optional: if the
 * artifact did not land, there is no evidence, and a proof row pointing at nothing would be worse
 * than no proof at all. So `store` throws, the capture fails, and the delivery stays where it was
 * (§19 of this work's brief).
 */
export interface IProofArtifactStoragePort {
  /** Stores the bytes and returns their handle. Throws if they could not be stored. */
  store(upload: ProofArtifactUpload): Promise<StoredProofArtifact>;

  /**
   * What is behind a handle, or `null` if nothing is.
   *
   * Metadata only — never content. The read path uses it to tell a customer that a photograph was
   * taken, and to let an operator confirm the evidence is still retrievable, without this module
   * ever moving an image through itself.
   */
  describe(ref: string): Promise<Omit<StoredProofArtifact, 'ref'> | null>;
}
