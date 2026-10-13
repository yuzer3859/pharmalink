export const FULFILLMENT_DELIVERY_JOB_LINK_REPOSITORY = Symbol('FULFILLMENT_DELIVERY_JOB_LINK_REPOSITORY');

/**
 * What recording a delivery-job reference on a fulfillment came to.
 *
 * - `LINKED` — `deliveryJobId` was null and is now the job's id.
 * - `ALREADY_LINKED` — it already held this job's id (a redelivered event); nothing was written.
 * - `CONFLICT` — it holds a *different* job's id. Never overwritten: Module 08 allows one job per
 *   fulfillment (`delivery_jobs.fulfillmentId` is unique), so two ids for one fulfillment is a data
 *   integrity problem for a person to look at, not something to resolve by last-writer-wins.
 * - `ORDER_MISMATCH` — the fulfillment exists but belongs to another order than the job names.
 * - `FULFILLMENT_NOT_FOUND` — no fulfillment has that id.
 */
export type DeliveryJobLinkOutcome = 'LINKED' | 'ALREADY_LINKED' | 'CONFLICT' | 'ORDER_MISMATCH' | 'FULFILLMENT_NOT_FOUND';

export interface DeliveryJobLinkInput {
  fulfillmentId: string;
  /** The order the job was cut for — must be the fulfillment's own order. */
  orderId: string;
  deliveryJobId: string;
}

/**
 * Module 06's one write of Module 08's job reference onto `fulfillments.deliveryJobId`.
 *
 * Kept apart from `IFulfillmentRepository` on purpose: that port persists validated *status*
 * transitions, and this is not one — it touches the reference column and nothing else, never the
 * status, timestamps or amounts. The write is a compare-and-set (`WHERE deliveryJobId IS NULL`), so
 * concurrent or repeated deliveries of one event cannot replace a reference already recorded.
 */
export interface IFulfillmentDeliveryJobLinkRepository {
  link(input: DeliveryJobLinkInput): Promise<DeliveryJobLinkOutcome>;
}
