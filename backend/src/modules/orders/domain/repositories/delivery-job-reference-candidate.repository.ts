import { FulfillmentStatus } from '../enums';

export const DELIVERY_JOB_REFERENCE_CANDIDATE_REPOSITORY = Symbol('DELIVERY_JOB_REFERENCE_CANDIDATE_REPOSITORY');

/**
 * The fulfillment statuses in which Module 08 can have cut a job: `READY` — the only state its
 * `CreateDeliveryJobCommand` accepts (BRULE-27, "isReadyForDelivery") — and the two post-handoff
 * states the schema reserves for later (`DISPATCHED`, `DELIVERED`; no Slice-1 transition reaches them
 * yet, since `READY` has no outgoing transition in `FulfillmentStatusPolicy`). Earlier states and
 * `CANCELLED` (reachable only before `READY`) can never carry a job, so they are never candidates and
 * are never re-selected.
 */
export const DELIVERY_JOB_REFERENCE_ELIGIBLE_STATUSES: readonly FulfillmentStatus[] = [
  FulfillmentStatus.READY,
  FulfillmentStatus.DISPATCHED,
  FulfillmentStatus.DELIVERED,
];

export interface DeliveryJobReferenceCandidate {
  fulfillmentId: string;
  orderId: string;
}

/**
 * Module 06's read for the reference reconciler: eligible fulfillments whose `deliveryJobId` is still
 * null, a bounded keyset page at a time (`id > afterId`, ascending), so a caller can walk the whole
 * set and wrap around instead of re-reading the same first page forever.
 */
export interface IDeliveryJobReferenceCandidateRepository {
  listUnreferenced(afterId: string | null, limit: number): Promise<DeliveryJobReferenceCandidate[]>;
}
