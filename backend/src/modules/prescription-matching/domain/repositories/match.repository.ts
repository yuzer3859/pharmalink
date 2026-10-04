import { MatchCoverage, MatchStatus, MatchStrategy } from '../enums';

export const MATCH_REPOSITORY = Symbol('MATCH_REPOSITORY');

/** One line of a resolved match (module-05 §3.6). */
export interface ChosenResultLine {
  catalogProductId: string;
  listingId: string;
  reservationId: string;
  quantity: number;
}

/** `MatchRequest.chosenResult` shape for Slice 1 — single-pharmacy only (§0.2, §3.6). */
export interface ChosenResult {
  pharmacyId: string;
  branchId: string;
  lines: ChosenResultLine[];
}

/** `MatchRequest` aggregate root row (module-05 §3.6). */
export interface MatchRequestSnapshot {
  id: string;
  orderId: string | null;
  customerUserId: string;
  deliveryLat: number | null;
  deliveryLng: number | null;
  status: MatchStatus;
  strategy: MatchStrategy;
  chosenResult: ChosenResult | null;
  overridePharmacyId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Data required to create a brand-new `MatchRequest` (`FindMatchCommand`, §5.5, §12). */
export interface NewMatchRequestData {
  orderId?: string | null;
  customerUserId: string;
  deliveryLat?: number | null;
  deliveryLng?: number | null;
  strategy?: MatchStrategy;
}

/** Child `MatchCandidate` ranked-snapshot row (module-05 §3.7). `rating`/`ratingCount` are never written by Slice 1 (§0.2) — always `null`. */
export interface MatchCandidateSnapshot {
  id: string;
  matchRequestId: string;
  pharmacyId: string;
  branchId: string;
  coverage: MatchCoverage;
  totalPrice: number;
  distanceMeters: number | null;
  rating: number | null;
  rank: number;
  createdAt: Date;
}

/** One ranked candidate to snapshot at `FindMatchCommand`/`RematchCommand` time (§3.7, §12). */
export interface NewMatchCandidateData {
  pharmacyId: string;
  branchId: string;
  coverage: MatchCoverage;
  totalPrice: number;
  distanceMeters?: number | null;
  rating?: number | null;
  rank: number;
}

/**
 * Fields a validated (`MatchStatusPolicy`) status transition writes (§8.3, §12 "Select
 * match"/"Rematch"). The caller has already validated the transition itself before calling this.
 */
export interface MatchStatusUpdate {
  status: MatchStatus;
  chosenResult?: ChosenResult | null;
  overridePharmacyId?: string | null;
}

/**
 * Persistence port for the `MatchRequest` aggregate root plus its child `MatchCandidate` ranked
 * snapshot rows (module-05 §3.6/§3.7, §11) — one repository for both, per the module's own file
 * layout naming only `IMatchRepository` (no separate candidate repository), matching how
 * `IPrescriptionRepository` also owns its child `PrescriptionLine` rows.
 *
 * Every mutating method accepts an optional `tx` handle so callers can compose calls inside this
 * module's own `Serializable` transaction for "Select match"/"Rematch" (§12) — which is
 * deliberately **separate** from Module 04's `IInventoryPort.reserve()`/`.release()` transaction
 * per ADR-014's two-transaction seam (§12): `reserve()` is called and awaited successfully
 * *before* `updateStatus(..., { status: MATCHED })` is called for `SelectMatchCommand`;
 * `release()` is called and awaited successfully *before* the re-rank `updateStatus`/
 * `replaceCandidates` calls for `RematchCommand`. This repository has no knowledge of that
 * ordering — it only persists whichever state the caller has already decided, in whichever order
 * the caller invokes it, so it cannot make the ADR-014 ordering impossible to implement correctly
 * (nor can it enforce it — that discipline belongs to the future `SelectMatchCommand`/
 * `RematchCommand` orchestration, not built by this task).
 */
export interface IMatchRepository {
  findById(id: string, tx?: unknown): Promise<MatchRequestSnapshot | null>;
  /** Inserts the `MatchRequest` header plus its ranked `MatchCandidate` snapshot rows in one write (§12 "Find match"). Caller has already ranked candidates via `MatchRankingStrategy` before calling this. */
  createWithCandidates(
    data: NewMatchRequestData,
    candidates: NewMatchCandidateData[],
    tx?: unknown,
  ): Promise<{ matchRequest: MatchRequestSnapshot; candidates: MatchCandidateSnapshot[] }>;
  listCandidates(matchRequestId: string, tx?: unknown): Promise<MatchCandidateSnapshot[]>;
  updateStatus(id: string, update: MatchStatusUpdate, tx?: unknown): Promise<void>;
  /** Replaces the candidate snapshot set for a re-rank pass (§8.3/§8.4 `RematchOrchestrator`, §12 "Rematch"). */
  replaceCandidates(
    matchRequestId: string,
    candidates: NewMatchCandidateData[],
    tx?: unknown,
  ): Promise<MatchCandidateSnapshot[]>;
}
