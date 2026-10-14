export const DELIVERY_JOB_REFERENCE_READ_PORT = Symbol('DELIVERY_JOB_REFERENCE_READ_PORT');

/** The most fulfillment ids one lookup accepts — a caller pages, this port never scans. */
export const MAX_DELIVERY_JOB_REFERENCE_LOOKUP = 500;

/** One job's identity: its id and the fulfillment and order it was cut for. Nothing else. */
export interface DeliveryJobReference {
  jobId: string;
  fulfillmentId: string;
  orderId: string;
}

/**
 * Module 08's exported contract for **which job, if any, exists for these fulfillments**, consumed
 * in-process by Module 06's reference reconciler (Work 45). Identifiers only — no status, driver,
 * address, offer, COD or tracking data. At most one job per fulfillment (`delivery_jobs.fulfillmentId`
 * is unique); a fulfillment with no job is simply absent. Read-only, and separate from Work 36's admin
 * read: this one serves Module 06's own consistency, not an operator.
 */
export interface IDeliveryJobReferenceReadPort {
  /** Throws on more than `MAX_DELIVERY_JOB_REFERENCE_LOOKUP` ids. */
  findByFulfillmentIds(fulfillmentIds: readonly string[]): Promise<DeliveryJobReference[]>;
}
