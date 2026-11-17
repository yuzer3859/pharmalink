export const RX_REQUEST_REPOSITORY = Symbol('ORDERS_RX_REQUEST_REPOSITORY');

export type RxRequestStatus = 'OPEN' | 'CLAIMED' | 'QUOTED' | 'CONFIRMED' | 'CANCELLED' | 'EXPIRED' | 'NO_PHARMACY';
export type RxRequestOfferStatus = 'OPEN' | 'WON' | 'TAKEN' | 'DECLINED' | 'LAPSED' | 'CLOSED';

export interface RxRequestOfferSnapshot {
  id: string;
  requestId: string;
  pharmacyId: string;
  branchId: string;
  distanceMeters: number;
  status: RxRequestOfferStatus;
  respondedAt: Date | null;
  reason: string | null;
  createdAt: Date;
}

export interface RxRequestSnapshot {
  id: string;
  customerUserId: string;
  prescriptionId: string;
  addressId: string;
  deliveryLat: number;
  deliveryLng: number;
  prescriptionIssueDate: Date;
  note: string | null;
  status: RxRequestStatus;
  expiresAt: Date;
  claimedPharmacyId: string | null;
  claimedBranchId: string | null;
  claimedByUserId: string | null;
  claimedAt: Date | null;
  claimExpiresAt: Date | null;
  quote: unknown;
  quotedAt: Date | null;
  quoteExpiresAt: Date | null;
  orderId: string | null;
  closedReason: string | null;
  closedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  offers: RxRequestOfferSnapshot[];
}

export interface NewRxRequestData {
  customerUserId: string;
  prescriptionId: string;
  addressId: string;
  deliveryLat: number;
  deliveryLng: number;
  prescriptionIssueDate: Date;
  note: string | null;
  status: 'OPEN' | 'NO_PHARMACY';
  expiresAt: Date;
  closedReason: string | null;
  closedAt: Date | null;
}

export interface NewRxRequestOfferData {
  pharmacyId: string;
  branchId: string;
  distanceMeters: number;
}

export interface RxClaim {
  requestId: string;
  pharmacyId: string;
  branchId: string;
  userId: string;
  now: Date;
  claimExpiresAt: Date;
}

/**
 * Work 134: persistence for prescription requests and their per-pharmacy offers. Every state change
 * is a compare-and-set (`updateMany` on the expected current state) returning whether it applied, so
 * two concurrent writers cannot both win: the database decides, never a read made earlier.
 */
export interface IRxRequestRepository {
  create(data: NewRxRequestData, offers: NewRxRequestOfferData[], tx?: unknown): Promise<RxRequestSnapshot>;
  findById(id: string, tx?: unknown): Promise<RxRequestSnapshot | null>;
  findByPrescriptionId(prescriptionId: string, tx?: unknown): Promise<RxRequestSnapshot | null>;
  listByCustomer(customerUserId: string, page: number, size: number): Promise<{ items: RxRequestSnapshot[]; total: number }>;
  /** Requests with an offer to one of `pharmacyIds` in one of `offerStatuses`, newest first. */
  listOfferedTo(pharmacyIds: string[], offerStatuses: RxRequestOfferStatus[], page: number, size: number): Promise<{ items: RxRequestSnapshot[]; total: number }>;

  /**
   * The first acceptance: `OPEN -> CLAIMED` only while the request is open and unexpired and this
   * pharmacy's offer is still open. `false` when another pharmacy got there first, or it ended.
   */
  claim(claim: RxClaim, tx?: unknown): Promise<boolean>;
  /**
   * `CLAIMED -> OPEN` for the pharmacy that holds it, offered again until `expiresAt`. `false`
   * when it no longer holds it.
   */
  release(requestId: string, pharmacyId: string, expiresAt: Date, tx?: unknown): Promise<boolean>;
  /** Ends the request from one of `from` with `status`. `false` when it was no longer in `from`. */
  close(requestId: string, from: RxRequestStatus[], status: RxRequestStatus, reason: string, now: Date, tx?: unknown): Promise<boolean>;

  /** Moves offers of the request from one of `from` to `to`; returns the pharmacies moved. */
  moveOffers(requestId: string, from: RxRequestOfferStatus[], to: RxRequestOfferStatus, now: Date, options?: { onlyPharmacyId?: string; exceptPharmacyId?: string; reason?: string }, tx?: unknown): Promise<string[]>;

  /** Locks, for the sweeper, one request whose offer window or claim lapsed before `now`. */
  lockNextDue(now: Date, excludeIds: readonly string[], tx: unknown): Promise<RxRequestSnapshot | null>;
}
