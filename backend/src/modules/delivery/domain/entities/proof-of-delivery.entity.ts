import { PodType } from '../enums';
import { DeliveryErrors } from '../errors';

/** Longest recipient name accepted. Generous for Ethiopian naming, bounded against abuse. */
export const MAX_RECIPIENT_NAME_LENGTH = 120;

/**
 * The persisted shape of a proof of delivery (§3.3 F-STS-04, §5.2, §8's `proof_of_delivery`).
 *
 * `orderId` and `fulfillmentId` are scalar copies of Module 06 identifiers (ADR-002) — never a
 * relation across the context boundary. `capturedByDriverId` is a `driver_profiles.id`, this
 * module's own operational driver, not a Module 01 user id.
 */
export interface ProofOfDeliveryProps {
  id: string;
  jobId: string;
  orderId: string;
  fulfillmentId: string;
  type: PodType;
  recipientName: string | null;
  recipientConfirmed: boolean;
  capturedByDriverId: string;
  /** Opaque handle into `IProofArtifactStoragePort`. `null` for a confirmation-only proof. */
  artifactRef: string | null;
  artifactContentType: string | null;
  artifactBytes: number | null;
  /** Hex SHA-256 of the stored bytes. */
  artifactSha256: string | null;
  capturedAt: Date;
  createdAt: Date;
}

/** What `ProofOfDelivery.capture` needs. */
export interface NewProofOfDeliveryInput {
  id: string;
  jobId: string;
  orderId: string;
  fulfillmentId: string;
  type: PodType;
  recipientName?: string | null;
  recipientConfirmed: boolean;
  capturedByDriverId: string;
  artifact?: {
    ref: string;
    contentType: string;
    bytes: number;
    sha256: string;
  } | null;
  now?: Date;
}

/**
 * `ProofOfDelivery` (§5.2) — evidence that a delivery was handed over.
 *
 * ## Immutable, and there is no method here that could change one
 *
 * The class exposes `capture` and `rehydrate` and nothing else. There is no setter, no `amend`,
 * no `attachArtifact`; the repository that persists it has an `insert` and no `update`; and
 * `proof_of_delivery.jobId` carries a unique index, so a second row for the same delivery is
 * refused by Postgres rather than by an application check somebody could later relax.
 *
 * That is a stronger guarantee than a version chain, and it is chosen over one deliberately. §7 of
 * this work's brief asks that evidence never be silently mutated and that corrections become new
 * auditable records — while also saying not to build a dispute/versioning workflow here. A
 * supersede column with no workflow to set it would be infrastructure pretending to be a feature:
 * nothing would write it, nothing would read it, and the first real correction would still need a
 * migration. So the guarantee this work actually ships is the absolute one — **evidence, once
 * accepted, cannot be altered or replaced by any code path that exists** — and the trail of
 * attempts lives in the hash-chained audit log beside it.
 *
 * When a correction workflow is genuinely needed, it arrives as a version chain: the unique index
 * moves to a partial one over the current row, and the work that adds it decides who may supersede
 * evidence and on what grounds. That is a policy question, not a schema oversight.
 *
 * ## What the aggregate validates, and what it does not
 *
 * It validates *coherence*: an artifact-typed proof must actually carry an artifact, a
 * confirmation-typed one must not pretend to, a stored artifact must have a size and a digest.
 * These are statements about whether the record makes sense as evidence, and they belong with the
 * evidence.
 *
 * It does **not** validate the media — MIME type, byte ceiling, decodability. Those are properties
 * of an upload, they are configurable, and checking them requires the bytes, which never reach the
 * domain. `CaptureProofOfDeliveryCommand` checks them before anything is stored.
 */
export class ProofOfDelivery {
  private constructor(private readonly props: ProofOfDeliveryProps) {}

  static capture(input: NewProofOfDeliveryInput): ProofOfDelivery {
    const now = input.now ?? new Date();
    const artifact = input.artifact ?? null;
    const recipientName = normalizeName(input.recipientName);

    if (ProofOfDeliveryTypeIsArtifact(input.type) && artifact === null) {
      // A `PHOTO` row with no photo would be a record asserting evidence exists when it does not —
      // worse than no record, because a dispute would go looking for a file that was never stored.
      throw DeliveryErrors.validation(`A ${input.type} proof of delivery requires an artifact.`, {
        field: 'artifact',
        type: input.type,
      });
    }

    if (input.type === PodType.CONFIRMATION && artifact !== null) {
      // The type is what a reader trusts when deciding what evidence exists. A confirmation
      // carrying a file would make the type unreliable; the caller means `SIGNATURE` or `PHOTO`.
      throw DeliveryErrors.validation(
        'A CONFIRMATION proof of delivery cannot carry an artifact.',
        { field: 'type', type: input.type },
      );
    }

    if (artifact !== null && (artifact.bytes <= 0 || artifact.sha256.trim() === '')) {
      // An artifact with no size or no digest cannot be checked later, which is most of what an
      // artifact is for.
      throw DeliveryErrors.validation('A stored artifact requires a size and a digest.', {
        field: 'artifact',
      });
    }

    return new ProofOfDelivery({
      id: input.id,
      jobId: input.jobId,
      orderId: input.orderId,
      fulfillmentId: input.fulfillmentId,
      type: input.type,
      recipientName,
      recipientConfirmed: input.recipientConfirmed,
      capturedByDriverId: input.capturedByDriverId,
      artifactRef: artifact?.ref ?? null,
      artifactContentType: artifact?.contentType ?? null,
      artifactBytes: artifact?.bytes ?? null,
      artifactSha256: artifact?.sha256 ?? null,
      capturedAt: now,
      createdAt: now,
    });
  }

  static rehydrate(props: ProofOfDeliveryProps): ProofOfDelivery {
    return new ProofOfDelivery({ ...props });
  }

  get id(): string {
    return this.props.id;
  }

  get type(): PodType {
    return this.props.type;
  }

  get artifactRef(): string | null {
    return this.props.artifactRef;
  }

  get recipientConfirmed(): boolean {
    return this.props.recipientConfirmed;
  }

  /** Whether this proof records the same evidence as an incoming submission (§10's retry). */
  matches(candidate: {
    type: PodType;
    recipientConfirmed: boolean;
    artifactSha256: string | null;
  }): boolean {
    return (
      this.props.type === candidate.type &&
      this.props.recipientConfirmed === candidate.recipientConfirmed &&
      this.props.artifactSha256 === candidate.artifactSha256
    );
  }

  toProps(): ProofOfDeliveryProps {
    return { ...this.props };
  }
}

function ProofOfDeliveryTypeIsArtifact(type: PodType): boolean {
  return type === PodType.SIGNATURE || type === PodType.PHOTO;
}

function normalizeName(value: string | null | undefined): string | null {
  const text = (value ?? '').trim();
  if (text === '') {
    return null;
  }
  if (text.length > MAX_RECIPIENT_NAME_LENGTH) {
    throw DeliveryErrors.validation(
      `recipientName must be at most ${MAX_RECIPIENT_NAME_LENGTH} characters.`,
      { field: 'recipientName' },
    );
  }
  return text;
}
