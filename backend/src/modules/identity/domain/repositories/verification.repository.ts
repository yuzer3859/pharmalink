import { VerificationRequest, VerificationDocument } from '../entities/verification-request.entity';
import { VerificationStatus, VerificationType } from '../enums';
import { PaginatedResult } from './auth.repositories';

export const VERIFICATION_REPOSITORY = Symbol('VERIFICATION_REPOSITORY');

export interface NewVerificationRequest {
  userId: string;
  organizationId: string | null;
  type: VerificationType;
  faydaIdEncrypted: string | null;
  documents: VerificationDocument[];
}

/**
 * Every field the admin queue may narrow by (module-16 §3 of the verification work). Each one is
 * a column `verification_requests` already has — nothing here is a filter over a derived or
 * invented attribute, which is why there is no free-text search and no "aging" criterion: age is
 * computed by the reader from `submittedAt`, not stored.
 */
export interface VerificationSearchFilter {
  status?: VerificationStatus;
  type?: VerificationType;
  userId?: string;
  organizationId?: string;
  /** Inclusive lower bound on `submittedAt`. */
  submittedFrom?: Date;
  /** Exclusive upper bound on `submittedAt`. */
  submittedTo?: Date;
}

/**
 * Optimistic guard for `save`: the stored row must still be in `status` for the write to apply.
 *
 * A review decision is a `PENDING → APPROVED | REJECTED` transition and it must happen once. The
 * aggregate refuses to re-decide a closed request, but that check runs against the copy each
 * reviewer loaded — two administrators who both read `PENDING` both pass it, and without this
 * guard the second `save` silently overwrote the first decision. Passing the expectation turns
 * the write into a compare-and-set on the status column; the loser gets
 * `IdentityErrors.verificationClosed` with the status that actually won.
 */
export interface SaveExpectation {
  status: VerificationStatus;
}

export interface IVerificationRepository {
  create(data: NewVerificationRequest): Promise<VerificationRequest>;
  findById(id: string): Promise<VerificationRequest | null>;
  /** The user's open (PENDING) request of a given type, if any — enforces one-at-a-time. */
  findPendingForUser(userId: string, type: VerificationType): Promise<VerificationRequest | null>;
  /** Every request for a user, newest first — powers GET /verification/status. */
  listForUser(userId: string): Promise<VerificationRequest[]>;
  listByStatus(
    status: VerificationStatus,
    page: number,
    size: number,
  ): Promise<PaginatedResult<VerificationRequest>>;
  /**
   * Filtered, paginated listing for the admin queue — oldest submission first, with the row id as
   * a tiebreaker so two requests submitted in the same millisecond page deterministically.
   */
  search(
    filter: VerificationSearchFilter,
    page: number,
    size: number,
  ): Promise<PaginatedResult<VerificationRequest>>;
  /** APPROVED requests whose licence expiry has passed (module-01 §9.3, BRULE-08). */
  listExpired(now: Date, limit: number): Promise<VerificationRequest[]>;
  /**
   * Persists the aggregate. With `expect`, the write applies only if the stored status still
   * matches (see `SaveExpectation`); otherwise it throws `verificationClosed` for the status found.
   */
  save(request: VerificationRequest, expect?: SaveExpectation): Promise<void>;
}

export const CONSENT_REPOSITORY = Symbol('CONSENT_REPOSITORY');

export interface IConsentRepository {
  /** Records an immutable consent decision (NFR-PRIV-03, module-01 §9.2 step 1). */
  record(userId: string, type: string, granted: boolean, version: string): Promise<void>;
}
