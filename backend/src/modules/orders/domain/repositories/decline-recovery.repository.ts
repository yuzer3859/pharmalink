export const DECLINE_RECOVERY_REPOSITORY = Symbol('DECLINE_RECOVERY_REPOSITORY');

export interface DeclineCandidateFulfillment {
  id: string;
  status: string;
  pharmacyId: string;
  branchId: string;
  createdAt: Date;
}

export interface DeclineCandidateLine {
  id: string;
  fulfillmentId: string | null;
  pharmacyId: string | null;
  branchId: string | null;
  reservationId: string | null;
  createdAt: Date;
}

/** An order that went through at least one pharmacy decline, with its fulfillments and lines. */
export interface DeclineCandidateOrder {
  id: string;
  status: string;
  fulfillments: DeclineCandidateFulfillment[];
  lines: DeclineCandidateLine[];
}

/**
 * Module 06's own rows for decline recovery (Work 55). A candidate is an order that is still live
 * (`PAID`/`ACCEPTED`), carries a `CANCELLED` fulfillment (only a pharmacy decline cancels one), and has
 * no customer cancellation request other than a `REJECTED` one — a cancellation in progress owns the
 * order's reservations. Reads only; no locks.
 */
export interface IDeclineRecoveryRepository {
  /** Keyset page by order id (for the reconciler). */
  listCandidates(afterOrderId: string | null, limit: number): Promise<DeclineCandidateOrder[]>;
  /** Offset page by order id plus the total (for the operational view). */
  pageCandidates(skip: number, take: number): Promise<{ orders: DeclineCandidateOrder[]; total: number }>;
  /** One order, only if it is (still) a candidate — the reconciler's re-check just before confirming. */
  findCandidate(orderId: string): Promise<DeclineCandidateOrder | null>;
}
