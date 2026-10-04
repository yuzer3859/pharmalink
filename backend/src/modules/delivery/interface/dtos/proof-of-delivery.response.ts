import { CaptureProofOfDeliveryResult } from '../../application/commands/capture-proof-of-delivery.command';
import { ProofOfDeliveryView } from '../../application/queries/get-proof-of-delivery.query';

/**
 * What either party is told about a delivery's evidence (§12, §14).
 *
 * An explicit allow-list, and here the list *is* the privacy boundary. A `proof_of_delivery` row
 * holds the storage handle for a photograph of somebody's front door and the id of the driver who
 * took it; neither appears below, and neither can appear by accident, because this type is built
 * field by field from `ProofOfDeliveryView`, which is itself built field by field from the row.
 *
 * What is deliberately absent:
 *
 *  - **`artifactRef`.** An opaque handle into private storage. It is not a URL and must never be
 *    treated as one, but a handle in a response body ends up in a browser history, a proxy log and
 *    a support screenshot, and the work that adds a storage provider should not inherit a handle
 *    already scattered across clients. §5 and §14 both ask for this specifically.
 *  - **A download URL of any kind.** There is no method on `IProofArtifactStoragePort` that could
 *    produce one. Serving the bytes is a separate capability with its own access decision, and it
 *    arrives with the provider.
 *  - **`capturedByDriverId`.** The tracking work established that a customer is told nothing about
 *    the driver's identity until there is a safe summary contract to serve it from, and evidence
 *    metadata is not the place to quietly break that. A driver reading their own capture already
 *    knows who they are.
 *  - **The bytes**, obviously, in any encoding.
 *
 * `sha256` *is* included, and is the one field here that needs justifying. It is not a secret — it
 * is a fingerprint of content the customer is entitled to know about, and it is what lets a file
 * produced months later during a dispute be shown to be the file that was captured at the door. A
 * digest that only the platform holds is a digest only the platform can be trusted about.
 */
export interface ProofOfDeliveryResponse {
  jobId: string;
  orderId: string;
  fulfillmentId: string;
  /** `CONFIRMATION`, `SIGNATURE` or `PHOTO`. */
  type: string;
  recipientName: string | null;
  recipientConfirmed: boolean;
  /** ISO-8601, and the server's clock — never a time the client supplied. */
  capturedAt: string;
  /** `null` for a confirmation-only proof. Metadata about the file, never the file. */
  artifact: {
    contentType: string;
    bytes: number;
    sha256: string;
    /** Whether storage can still account for the artifact this row describes. */
    available: boolean;
  } | null;
}

/**
 * The capture response.
 *
 * `created` is the honest distinction between "this submission recorded the evidence" and "the
 * evidence was already recorded and this submission matched it" (§10). A client does not need it
 * to behave correctly — both are success, both return the same proof — but a handset that retried
 * after a timeout deserves to be able to tell which of the two happened, and a support engineer
 * reading a capture log needs to.
 */
export interface CaptureProofOfDeliveryResponse extends ProofOfDeliveryResponse {
  created: boolean;
}

export function toProofOfDeliveryResponse(view: ProofOfDeliveryView): ProofOfDeliveryResponse {
  return {
    jobId: view.jobId,
    orderId: view.orderId,
    fulfillmentId: view.fulfillmentId,
    type: view.type,
    recipientName: view.recipientName,
    recipientConfirmed: view.recipientConfirmed,
    capturedAt: view.capturedAt.toISOString(),
    artifact:
      view.artifact === null
        ? null
        : {
            contentType: view.artifact.contentType,
            bytes: view.artifact.bytes,
            sha256: view.artifact.sha256,
            available: view.artifact.available,
          },
  };
}

/**
 * The capture path's mapper.
 *
 * It maps from the persisted row rather than from the read query's view, which means it never asks
 * storage whether the artifact is retrievable: the command has just stored it, so `available` is
 * `true` by construction and a second round trip to confirm what was done a moment ago would be
 * ceremony. A client that wants the storage-side check reads the GET.
 */
export function toCaptureProofOfDeliveryResponse(
  result: CaptureProofOfDeliveryResult,
): CaptureProofOfDeliveryResponse {
  const proof = result.proof;
  return {
    jobId: proof.jobId,
    orderId: proof.orderId,
    fulfillmentId: proof.fulfillmentId,
    type: proof.type,
    recipientName: proof.recipientName,
    recipientConfirmed: proof.recipientConfirmed,
    capturedAt: proof.capturedAt.toISOString(),
    artifact:
      proof.artifactRef === null
        ? null
        : {
            contentType: proof.artifactContentType ?? 'application/octet-stream',
            bytes: proof.artifactBytes ?? 0,
            sha256: proof.artifactSha256 ?? '',
            available: true,
          },
    created: result.created,
  };
}
