import { createHash, randomUUID } from 'crypto';
import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../../../shared/audit/audit.service';
import { CONFIG_PORT, IConfigPort } from '../../../../shared/config/config.port';
import { DEFAULT_DELIVERY_POD_MAX_ARTIFACT_BYTES } from '../../../../shared/config/delivery.config';
import {
  ProofOfDelivery,
  ProofOfDeliveryProps,
} from '../../domain/entities/proof-of-delivery.entity';
import { PodType } from '../../domain/enums';
import { DeliveryErrors } from '../../domain/errors';
import {
  DELIVERY_JOB_REPOSITORY,
  IDeliveryJobRepository,
} from '../../domain/repositories/delivery-job.repository';
import {
  DRIVER_PROFILE_REPOSITORY,
  IDriverProfileRepository,
} from '../../domain/repositories/driver-profile.repository';
import {
  IProofOfDeliveryRepository,
  PROOF_OF_DELIVERY_REPOSITORY,
} from '../../domain/repositories/proof-of-delivery.repository';
import { ProofOfDeliveryPolicy } from '../../domain/services/proof-of-delivery-policy';
import {
  IProofArtifactStoragePort,
  PROOF_ARTIFACT_STORAGE_PORT,
} from '../ports/outbound/proof-artifact-storage.port';
import { IUnitOfWork, UNIT_OF_WORK } from '../ports/unit-of-work.port';
import { runWithDeliveryRetry } from '../support/delivery-retry';

/** The dotted config key bounding artifact size. */
export const POD_MAX_ARTIFACT_BYTES_CONFIG_KEY = 'delivery.podMaxArtifactBytes';

/**
 * Content types a proof artifact may carry.
 *
 * A constant rather than a config key, deliberately. This is an allow-list guarding what the
 * platform will accept and store on a customer's behalf, not an operational tunable — an operator
 * who could widen it from an environment variable could turn a delivery endpoint into a way to
 * store arbitrary file types, and the review that should accompany adding a format belongs in a
 * pull request rather than in a deployment.
 *
 * Three raster formats, all of which every mobile handset can produce. No SVG: it is an XML
 * document that can carry script, and a signature pad emitting one would be storing executable
 * content as evidence. No PDF, for the same reason and more.
 */
export const ALLOWED_POD_CONTENT_TYPES: readonly string[] = [
  'image/png',
  'image/jpeg',
  'image/webp',
];

export interface ProofArtifactInput {
  contentType: string;
  /** Base64-encoded bytes. Never logged, never echoed, never persisted in a row. */
  contentBase64: string;
}

export interface CaptureProofOfDeliveryInput {
  /** Module 01 `users.id`, from the access token. **Never** a client-supplied driver id. */
  userId: string;
  jobId: string;
  type: PodType;
  recipientName?: string | null;
  /** The recipient's attestation that they received the order. */
  recipientConfirmed: boolean;
  artifact?: ProofArtifactInput | null;
}

export interface CaptureProofOfDeliveryResult {
  proof: ProofOfDeliveryProps;
  /** `false` when this submission matched evidence already captured — an idempotent retry. */
  created: boolean;
}

/**
 * `CaptureProofOfDelivery` (§3.3 F-STS-04, §11.4, BR-DEL-06, BRULE-29) — records the evidence that
 * a delivery was handed over.
 *
 * ## Order of operations, and why the storage call sits outside the transaction
 *
 * 1. **Authorize** — the caller must be the job's currently assigned driver, resolved from their
 *    token. A mismatch answers `NOT_FOUND`.
 * 2. **Check the stage** — `ARRIVED_DROPOFF` only, per `ProofOfDeliveryPolicy`.
 * 3. **Short-circuit an existing proof** — read before storing anything, so the overwhelmingly
 *    common retry costs one indexed read and no storage write at all.
 * 4. **Validate the media** — content type against the allow-list, decoded size against the cap.
 *    Before storage, so nothing oversized or unsupported is ever written anywhere.
 * 5. **Store the artifact**, outside any transaction (ADR-014 — external I/O must not run inside a
 *    `Serializable` transaction, where it would hold locks for the length of a network call).
 * 6. **Write the row and its audit entry**, together, in one `Serializable` transaction.
 *
 * The gap between 5 and 6 is real and is the right way round. If the transaction fails after the
 * artifact has landed, the platform is left holding an orphaned blob — garbage, which a storage
 * lifecycle policy can sweep. The alternative ordering leaves a proof row pointing at an artifact
 * that was never stored, which is evidence that does not exist being cited as evidence that does.
 * Content addressing makes the orphan self-healing anyway: a retry stores identical bytes under
 * the identical handle rather than accumulating copies.
 *
 * ## Idempotency is the database's, not a cache's
 *
 * `proof_of_delivery.jobId` is unique, so one delivery has at most one proof and the constraint —
 * not an application check — is what enforces it. A retry therefore has three possible outcomes,
 * and all three are decided by comparing what is stored against what arrived:
 *
 *  - **same evidence** — the first submission succeeded and this is the handset asking again.
 *    Returns the stored proof with `created: false`. No second row, no second artifact, no second
 *    audit entry, and no second delivery transition downstream.
 *  - **different evidence** — a request to replace a delivery's proof, which §7 forbids. Refused
 *    with a conflict rather than silently keeping the first, because reporting success for a
 *    submission that was discarded would be a lie about what the evidence is.
 *  - **nothing stored** — the ordinary first capture.
 *
 * The same three apply to two genuinely concurrent submissions: `insert` returns `null` on the
 * unique-constraint collision, and the loser re-reads and takes the same branch. Nothing here
 * depends on process memory, which §10 requires — two API nodes settle it through Postgres.
 *
 * ## What never touches a log, a row or an event
 *
 * The bytes. They arrive base64 in a request body, are decoded into a `Buffer`, handed to the
 * storage port, and go out of scope. No log line, error message, audit entry or event payload in
 * this file carries `contentBase64` or the buffer; the audit records the *type*, the handle and
 * the digest, which is what §13 asks for and what a dispute can act on.
 */
@Injectable()
export class CaptureProofOfDeliveryCommand {
  constructor(
    @Inject(DELIVERY_JOB_REPOSITORY) private readonly jobs: IDeliveryJobRepository,
    @Inject(DRIVER_PROFILE_REPOSITORY) private readonly profiles: IDriverProfileRepository,
    @Inject(PROOF_OF_DELIVERY_REPOSITORY) private readonly proofs: IProofOfDeliveryRepository,
    @Inject(PROOF_ARTIFACT_STORAGE_PORT) private readonly storage: IProofArtifactStoragePort,
    @Inject(UNIT_OF_WORK) private readonly uow: IUnitOfWork,
    @Inject(CONFIG_PORT) private readonly config: IConfigPort,
    private readonly audit: AuditService,
  ) {}

  async execute(input: CaptureProofOfDeliveryInput): Promise<CaptureProofOfDeliveryResult> {
    const userId = requireText(input.userId, 'userId');
    const jobId = requireText(input.jobId, 'jobId');

    if (!Object.values(PodType).includes(input.type)) {
      throw DeliveryErrors.validation('type must be CONFIRMATION, SIGNATURE or PHOTO.', {
        field: 'type',
      });
    }

    // Step 1. The driver is resolved from the token; no input field carries a driver id.
    const profile = await this.profiles.findByUserId(userId);
    if (!profile) {
      throw DeliveryErrors.driverProfileNotFound({ userId });
    }

    const job = await this.jobs.findById(jobId);
    // Both "no such job" and "somebody else's job" answer identically — a job id is not an oracle
    // for who is carrying what (`00-shared-conventions.md` §1). A driver reassigned off the job
    // loses the ability to attach evidence at the same instant they lose the job.
    if (!job || job.assignedDriverId !== profile.id) {
      throw DeliveryErrors.notFound('Delivery job not found.', { jobId });
    }

    // Step 2. Evidence of a handover is captured at the door, not before arriving and not after
    // the delivery has already been recorded on the strength of other evidence.
    if (!ProofOfDeliveryPolicy.isCaptureAllowedIn(job.status)) {
      throw DeliveryErrors.proofOfDeliveryNotAcceptable(jobId, job.status);
    }

    // Step 3. Read before writing anything: a retry is the common case and must be cheap.
    const existing = await this.proofs.findByJobId(jobId);
    // Step 4, ahead of the branch: decoded and validated exactly once, so a retry is refused for a
    // bad content type just as a first attempt would be, and the digest that identifies the
    // evidence is computed from the same bytes that will be stored.
    const content = input.artifact ? this.decode(input.artifact) : null;
    const incomingDigest = content ? sha256Of(content) : null;
    if (existing) {
      return this.resolveExisting(existing, input, incomingDigest);
    }

    // Step 5. Storage, outside any transaction.
    const stored =
      content && input.artifact
        ? await this.storage.store({
            jobId,
            contentType: input.artifact.contentType.trim().toLowerCase(),
            content,
          })
        : null;

    const proof = ProofOfDelivery.capture({
      id: randomUUID(),
      jobId,
      orderId: job.orderId,
      fulfillmentId: job.fulfillmentId,
      type: input.type,
      recipientName: input.recipientName ?? null,
      recipientConfirmed: input.recipientConfirmed,
      capturedByDriverId: profile.id,
      artifact: stored
        ? {
            ref: stored.ref,
            contentType: stored.contentType,
            bytes: stored.bytes,
            sha256: stored.sha256,
          }
        : null,
    });

    // Step 6. Row and audit entry together, per ADR-013.
    //
    // The transaction does one of two things and nothing else: it writes the proof and its audit
    // entry, or it reports that the unique index refused. It deliberately does **not** recover
    // from the collision in place. A unique violation puts a Postgres transaction into an aborted
    // state, so every subsequent statement on that connection fails until it unwinds — the re-read
    // has to happen on a fresh one, and a version of this that read the winner here would have
    // turned a perfectly ordinary concurrent retry into a 500.
    const written = await runWithDeliveryRetry(this.uow, async (tx) => {
      const inserted = await this.proofs.insert(proof.toProps(), tx);
      if (!inserted) {
        return null;
      }

      await this.audit.record(
        {
          actorUserId: userId,
          action: 'DELIVERY_POD_CAPTURED',
          resourceType: 'ProofOfDelivery',
          resourceId: inserted.id,
          context: {
            jobId,
            orderId: job.orderId,
            fulfillmentId: job.fulfillmentId,
            driverId: profile.id,
            type: inserted.type,
            recipientConfirmed: inserted.recipientConfirmed,
            // The handle and the digest, never the bytes. Together they are what lets a dispute
            // establish that the artifact produced later is the artifact captured now.
            artifactRef: inserted.artifactRef,
            artifactSha256: inserted.artifactSha256,
            artifactBytes: inserted.artifactBytes,
          },
        },
        tx,
      );

      return inserted;
    });

    if (written === null) {
      // Lost the race. The winner is committed by now — the loser's own transaction has unwound —
      // so a fresh read outside it takes exactly the branch a sequential retry would have taken:
      // identical evidence succeeds idempotently, different evidence is refused.
      const winner = await this.proofs.findByJobId(jobId);
      if (!winner) {
        throw DeliveryErrors.proofOfDeliveryAlreadyCaptured(jobId);
      }
      return this.resolveExisting(winner, input, incomingDigest);
    }

    return { proof: written, created: true };
  }

  /**
   * What to do when the delivery already has proof.
   *
   * Identical evidence is the handset retrying and succeeds silently; anything else is an attempt
   * to replace evidence and is refused. Comparing the *digest* rather than the handle is what makes
   * this work — two submissions of the same photograph produce the same digest whether or not the
   * first one's storage write is still reachable.
   */
  private resolveExisting(
    existing: ProofOfDeliveryProps,
    input: CaptureProofOfDeliveryInput,
    incomingDigest: string | null,
  ): CaptureProofOfDeliveryResult {
    const same = ProofOfDelivery.rehydrate(existing).matches({
      type: input.type,
      recipientConfirmed: input.recipientConfirmed,
      artifactSha256: incomingDigest,
    });
    if (!same) {
      throw DeliveryErrors.proofOfDeliveryAlreadyCaptured(existing.jobId);
    }
    return { proof: existing, created: false };
  }

  /**
   * Decodes and validates an artifact's bytes.
   *
   * Both checks happen before storage so that nothing unsupported or oversized is ever written.
   * The content type is checked against a fixed allow-list; the size is checked against the
   * *decoded* length rather than the base64 string, because the cap is a statement about how much
   * data the platform will keep and base64 inflates by a third.
   *
   * A payload that is not valid base64 is a client defect and is refused as validation, with no
   * mention of the payload itself in the message.
   */
  private decode(artifact: ProofArtifactInput): Buffer {
    const contentType = (artifact.contentType ?? '').trim().toLowerCase();
    if (!ALLOWED_POD_CONTENT_TYPES.includes(contentType)) {
      throw DeliveryErrors.validation(
        `Unsupported artifact content type. Accepted: ${ALLOWED_POD_CONTENT_TYPES.join(', ')}.`,
        { field: 'artifact.contentType', contentType },
      );
    }

    const raw = (artifact.contentBase64 ?? '').trim();
    if (raw === '') {
      throw DeliveryErrors.validation('artifact.contentBase64 is required.', {
        field: 'artifact.contentBase64',
      });
    }

    const content = Buffer.from(raw, 'base64');
    if (content.length === 0) {
      throw DeliveryErrors.validation('artifact.contentBase64 is not valid base64.', {
        field: 'artifact.contentBase64',
      });
    }

    const max = this.maxArtifactBytes();
    if (content.length > max) {
      throw DeliveryErrors.validation(`Artifact exceeds the ${max}-byte limit.`, {
        field: 'artifact.contentBase64',
        // The size, never the content.
        bytes: content.length,
        maxBytes: max,
      });
    }

    return content;
  }

  private maxArtifactBytes(): number {
    const configured = this.config.get<number>(POD_MAX_ARTIFACT_BYTES_CONFIG_KEY);
    return typeof configured === 'number' && Number.isInteger(configured) && configured > 0
      ? configured
      : DEFAULT_DELIVERY_POD_MAX_ARTIFACT_BYTES;
  }
}

function sha256Of(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function requireText(value: string, field: string): string {
  const text = (value ?? '').trim();
  if (!text) {
    throw DeliveryErrors.validation(`${field} is required.`, { field });
  }
  return text;
}
