import { FulfillmentStatus } from '../../../domain/enums';

export const FULFILLMENT_OPERATIONS_READ_PORT = Symbol('FULFILLMENT_OPERATIONS_READ_PORT');

/** Re-exported so a consumer depends on this one file and not on Module 06's domain layer. */
export { FulfillmentStatus } from '../../../domain/enums';

/** Every filter is a column of `fulfillments`, matched exactly or as a window. */
export interface FulfillmentOperationsFilter {
  status?: FulfillmentStatus;
  orderId?: string;
  pharmacyId?: string;
  branchId?: string;
  /** `deliveryJobId IS NOT NULL` (`true`) / `IS NULL` (`false`). */
  hasDeliveryJobReference?: boolean;
  /** Inclusive lower / exclusive upper bound on `createdAt`. */
  createdFrom?: Date;
  createdTo?: Date;
  /** Inclusive lower / exclusive upper bound on `readyAt` (set when the fulfillment is marked READY). */
  readyFrom?: Date;
  readyTo?: Date;
}

/**
 * One fulfillment — Module 06's own row, the same fields Work 35's order detail already shows per
 * fulfillment, plus its order and the reference flag. `fulfillments` has no `updatedAt` and no soft
 * delete.
 *
 * `deliveryJobId` is Module 08's job **by reference only**, for navigation to the delivery detail.
 * `hasDeliveryJobReference` is `deliveryJobId !== null`: a recorded id — not proof that the job is
 * active, assigned or delivered, and its absence is not proof that Module 08 has no job (a missed
 * `delivery.job.created` is recovered by Module 06's reference reconciler). No delivery status is
 * derived here.
 */
export interface FulfillmentOperationsView {
  fulfillmentId: string;
  orderId: string;
  pharmacyId: string;
  branchId: string;
  status: FulfillmentStatus;
  deliveryJobId: string | null;
  hasDeliveryJobReference: boolean;
  acceptedAt: Date | null;
  readyAt: Date | null;
  createdAt: Date;
}

export interface FulfillmentOperationsPage {
  items: FulfillmentOperationsView[];
  total: number;
  page: number;
  size: number;
}

/**
 * Module 06's exported, read-only contract for **administrative fulfillment investigation**
 * (module-16 Work 46). Kept apart from the order-centred `IOrderOperationsReadPort`. Newest first
 * (`createdAt`, then `id`), paged in the database. It writes nothing and calls no other module.
 */
export interface IFulfillmentOperationsReadPort {
  listFulfillments(filter: FulfillmentOperationsFilter, page: number, size: number): Promise<FulfillmentOperationsPage>;
  /** `null` when there is no such fulfillment. */
  getFulfillment(fulfillmentId: string): Promise<FulfillmentOperationsView | null>;
}
