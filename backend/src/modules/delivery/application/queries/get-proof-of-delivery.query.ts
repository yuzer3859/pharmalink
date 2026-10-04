import { Inject, Injectable } from '@nestjs/common';
import { PodType } from '../../domain/enums';
import { DeliveryErrors } from '../../domain/errors';
import {
  DELIVERY_JOB_REPOSITORY,
  IDeliveryJobRepository,
} from '../../domain/repositories/delivery-job.repository';
import {
  IProofOfDeliveryRepository,
  PROOF_OF_DELIVERY_REPOSITORY,
} from '../../domain/repositories/proof-of-delivery.repository';
import {
  IProofArtifactStoragePort,
  PROOF_ARTIFACT_STORAGE_PORT,
  StoredProofArtifact,
} from '../ports/outbound/proof-artifact-storage.port';
import { DeliveryAccessService, DeliveryViewer } from '../services/delivery-access.service';

/**
 * What a proof of delivery looks like to somebody entitled to see it.
 *
 * Metadata about the evidence, never the evidence. See the class comment for why there is no URL
 * and no byte array here, and why that is a decision rather than an omission.
 */
export interface ProofOfDeliveryView {
  jobId: string;
  orderId: string;
  fulfillmentId: string;
  type: PodType;
  /** Who took delivery, as the driver recorded it. `null` when they did not record a name. */
  recipientName: string | null;
  recipientConfirmed: boolean;
  capturedAt: Date;
  /** `null` for a confirmation-only proof — no file was ever captured. */
  artifact: {
    contentType: string;
    bytes: number;
    /** Hex SHA-256 of the captured bytes, so a file produced later can be shown to be that file. */
    sha256: string;
    /**
     * Whether the stored artifact is still retrievable from the storage provider.
     *
     * `false` means the row says a photograph was taken and storage can no longer account for it —
     * worth surfacing rather than hiding, because an operator investigating a dispute needs to
     * know that before they promise anybody a picture.
     */
    available: boolean;
  } | null;
}

export interface ProofOfDeliveryAccess {
  view: ProofOfDeliveryView;
  viewer: DeliveryViewer;
}

/**
 * `GetProofOfDelivery` (§12 of the PoD brief, §3.3 F-STS-04) — the authorized read of a delivery's
 * evidence.
 *
 * ## Authorization is not decided here
 *
 * It is decided in `DeliveryAccessService`, which is the same call the tracking snapshot makes.
 * That is deliberate and it is the whole reason that service exists: a customer who may not see
 * where their neighbour's driver is must not be able to see the photograph of their neighbour's
 * doorstep, and the only durable guarantee of that is that both reads ask one function. A job id
 * that resolves to neither the buyer nor the assigned driver answers `NOT_FOUND`, never
 * `FORBIDDEN` — a delivery id must not be an oracle for who has ordered medicines
 * (`00-shared-conventions.md` §1).
 *
 * Both parties get the same view. There is no field below that one may see and the other may not,
 * because there is no field below that would be unsafe for either: the driver captured this
 * evidence, and the customer is the person it is evidence *about*. A field that genuinely needed
 * to differ — an operations note, a reviewer's finding — would arrive with the work that adds it
 * and with an administrative permission to gate it, and the catalogue has neither yet.
 *
 * ## No URL, no bytes, and no method that could produce either
 *
 * The artifact is described, not served: content type, size, digest, and whether storage can still
 * account for it. `artifactRef` itself never leaves this query — it is an opaque handle into
 * private storage, and a handle that appeared in a response body would be in a browser history, a
 * proxy log and a screenshot within the day.
 *
 * This is not a gap waiting to be plugged with a signed URL. `IProofArtifactStoragePort` has no
 * method that returns one, deliberately: deciding who may download a photograph of somebody's
 * front door, for how long, and audited how, is a real access-control design, and it belongs with
 * the work that chooses a storage provider rather than being smuggled in beside a metadata read.
 *
 * ## An absent proof is a `NOT_FOUND`, and that is safe here
 *
 * Access to the *job* is established first and independently, so "this delivery has no proof" is
 * only ever told to somebody already entitled to know everything else about the delivery. It
 * discloses nothing, and it is the honest answer: most deliveries on the platform have no proof at
 * all, because every proof-of-delivery requirement ships defaulted to `NONE`.
 */
@Injectable()
export class GetProofOfDeliveryQuery {
  constructor(
    @Inject(DELIVERY_JOB_REPOSITORY) private readonly jobs: IDeliveryJobRepository,
    @Inject(PROOF_OF_DELIVERY_REPOSITORY) private readonly proofs: IProofOfDeliveryRepository,
    @Inject(PROOF_ARTIFACT_STORAGE_PORT) private readonly storage: IProofArtifactStoragePort,
    private readonly access: DeliveryAccessService,
  ) {}

  async byJobId(jobId: string, userId: string): Promise<ProofOfDeliveryAccess> {
    const id = requireText(jobId, 'jobId');
    const job = await this.jobs.findById(id);
    if (!job) {
      throw DeliveryErrors.notFound('Delivery job not found.', { id });
    }

    // Before any evidence is read. A caller who is not entitled to the delivery never causes a
    // proof row to be fetched, let alone a storage provider to be asked about an artifact.
    const viewer = await this.access.resolve(job, requireText(userId, 'userId'), id);

    const proof = await this.proofs.findByJobId(job.id);
    if (!proof) {
      throw DeliveryErrors.notFound('Proof of delivery not found.', { jobId: job.id });
    }

    // Metadata only, and only when there is a handle to ask about. A storage provider that is
    // unreachable must not turn a legitimate read into a failure — the row is the record, and the
    // artifact's retrievability is a detail of it, so a failure here reports `available: false`
    // rather than propagating.
    const described = proof.artifactRef ? await this.describe(proof.artifactRef) : null;

    return {
      viewer,
      view: {
        jobId: proof.jobId,
        orderId: proof.orderId,
        fulfillmentId: proof.fulfillmentId,
        type: proof.type,
        recipientName: proof.recipientName,
        recipientConfirmed: proof.recipientConfirmed,
        capturedAt: proof.capturedAt,
        artifact:
          proof.artifactRef === null
            ? null
            : {
                // The row is the authority on what was captured; storage is only asked whether it
                // still holds it. Reporting the *stored* metadata instead would mean a corrupted
                // or replaced object could silently change what the platform says the evidence was.
                contentType: proof.artifactContentType ?? 'application/octet-stream',
                bytes: proof.artifactBytes ?? 0,
                sha256: proof.artifactSha256 ?? '',
                available: described !== null,
              },
      },
    };
  }

  private async describe(ref: string): Promise<Omit<StoredProofArtifact, 'ref'> | null> {
    try {
      return await this.storage.describe(ref);
    } catch {
      // Deliberately swallowed and deliberately not logged with the handle: an internal storage
      // path in an application log is the leak §14 asks this work to avoid.
      return null;
    }
  }
}

function requireText(value: string, field: string): string {
  const text = (value ?? '').trim();
  if (!text) {
    throw DeliveryErrors.validation(`${field} is required.`, { field });
  }
  return text;
}
