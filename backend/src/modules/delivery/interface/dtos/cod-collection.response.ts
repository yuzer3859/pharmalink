import { CodCollectionView } from '../../application/queries/get-cod-collection.query';
import { RecordCodCollectionResult } from '../../application/commands/record-cod-collection.command';
import {
  CodCollectionProps,
  hasDiscrepancy,
  varianceOf,
} from '../../domain/entities/cod-collection.entity';
import { CodCollectionPolicy } from '../../domain/services/cod-collection-policy';

/**
 * What a driver is told about the cash they recorded taking (§17, §23's "no sensitive provider
 * fields").
 *
 * ## An explicit allow-list, and the list is the privacy boundary
 *
 * Built field by field from the row, which is itself built field by field from a request that had
 * nowhere to put a secret. What is absent is absent by construction rather than by filtering:
 *
 *  - **No provider payload, callback body, signature or account identifier.** None of it is ever
 *    accepted, so none of it can be echoed. `providerReference` is an opaque transaction number a
 *    human quotes during reconciliation — not a credential, and the only provider-adjacent value
 *    this module holds.
 *  - **Nothing about the customer.** No name, no phone, no address, no token. A COD record is about
 *    the platform's arrangement with its collection channel.
 *  - **No settlement or payout figure**, because this module has none.
 *
 * ## The three amounts, and why all three are shown
 *
 * `expectedAmount`, `collectedAmount` and the signed `variance`. A driver who handed over less than
 * the order came to is entitled to see that the platform recorded exactly that, and a driver who
 * collected correctly is entitled to see the variance is zero. Showing only the collected figure
 * would make a shortfall something the driver discovers later from somebody else.
 *
 * ## `status` says how far the money has got, and no further
 *
 * `COLLECTED` means **the driver declared they received it**. It does not mean PharmaLink has the
 * money, that anybody has counted it, or that the pharmacy has been paid — three separate facts
 * that this field deliberately keeps separate. `isReconcilable` is the platform's own view of
 * whether this record *could* be reconciled as it stands, and is never `true` where the amounts
 * disagree.
 */
export interface CodCollectionResponse {
  id: string;
  jobId: string;
  orderId: string;
  fulfillmentId: string;
  /** What the order came to, from the job's frozen snapshot. */
  expectedAmount: number;
  /** What the driver declared they received. */
  collectedAmount: number;
  /** `collectedAmount − expectedAmount`. Negative is a shortfall. */
  variance: number;
  currency: string;
  /** `CASH` or `ELECTRONIC`. */
  method: string;
  /** `COLLECTED`, `REMITTED` or `RECONCILED`. Delivery only ever writes the first. */
  status: string;
  /** An opaque transaction reference, or `null`. Never a provider payload. */
  providerReference: string | null;
  /** ISO-8601 — when the driver says the money changed hands. */
  collectedAt: string;
  /** ISO-8601 — when the platform recorded it. */
  recordedAt: string;
  /** Whether the amounts disagree. */
  hasDiscrepancy: boolean;
  /** Whether this could be reconciled as it stands. Never `true` alongside a discrepancy. */
  isReconcilable: boolean;
  /**
   * Whether PharmaLink has an open question about this collection (§12).
   *
   * A boolean and nothing more — no reason, no note, no operator, and no correction history. A
   * driver is entitled to know their cash is being queried; the contents of the query are a finance
   * matter, and publishing an investigation to its subject is a decision nobody has taken.
   */
  hasOpenDispute: boolean;
}

/**
 * The recording response.
 *
 * `created` is the honest distinction between "this submission recorded the collection" and "the
 * collection was already recorded and this submission matched it". A handset that retried after a
 * timeout at somebody's door deserves to know which of the two happened, and a support engineer
 * reading a COD log needs to.
 */
export interface RecordCodCollectionResponse extends CodCollectionResponse {
  created: boolean;
}

function baseResponse(
  collection: CodCollectionProps,
  hasOpenDispute: boolean,
): CodCollectionResponse {
  return {
    id: collection.id,
    jobId: collection.jobId,
    orderId: collection.orderId,
    fulfillmentId: collection.fulfillmentId,
    expectedAmount: collection.expectedAmount,
    collectedAmount: collection.collectedAmount,
    variance: varianceOf(collection),
    currency: collection.currency,
    method: collection.method,
    status: collection.status,
    providerReference: collection.providerReference,
    collectedAt: collection.collectedAt.toISOString(),
    recordedAt: collection.recordedAt.toISOString(),
    hasDiscrepancy: hasDiscrepancy(collection),
    isReconcilable: CodCollectionPolicy.isReconcilable(collection),
    hasOpenDispute,
  };
}

export function toCodCollectionResponse(view: CodCollectionView): CodCollectionResponse {
  return baseResponse(view.collection, view.hasOpenDispute);
}

export function toRecordCodCollectionResponse(
  result: RecordCodCollectionResult,
): RecordCodCollectionResponse {
  // `false` by construction rather than by a lookup: this response is the answer to a driver's own
  // submission at a customer's door, and a collection recorded a moment ago has nothing disputed
  // about it yet. The driver's GET is where a later dispute becomes visible.
  return { ...baseResponse(result.collection, false), created: result.created };
}
