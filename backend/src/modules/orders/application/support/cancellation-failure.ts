import { ApiException } from '../../../../shared/errors/api-exception';
import { ErrorCode } from '../../../../shared/errors/error-codes';
import { isDispatchedReservationRejection } from '../../../pharmacy-inventory/application/ports/inbound/inventory.port';
import { isSerializationConflict } from './order-retry';

/**
 * How a failed cancellation step must be treated (Work 55):
 *  - `DISPATCHED` — Module 04 refused: stock already left. Final; the cancellation is rejected.
 *  - `TRANSIENT`  — the infrastructure, not the request, failed (connectivity, pool or transaction
 *    timeouts, write conflicts, `runWithOrderRetry`'s exhausted-retry `CONFLICT`,
 *    `DEPENDENCY_UNAVAILABLE`, or an unrecognised non-domain error). Retried with backoff, boundedly.
 *  - `PERMANENT`  — a domain/integrity answer that a retry cannot change (`LISTING_NOT_FOUND` for a
 *    soft-deleted listing, `RESERVATION_NOT_FOUND`, a `VALIDATION_ERROR` invariant, a policy refusal):
 *    flagged for an operator at once.
 */
export type CancellationFailureKind = 'DISPATCHED' | 'TRANSIENT' | 'PERMANENT';

/**
 * Prisma codes for a lost/unavailable connection, a pool or interactive-transaction timeout, or a
 * write conflict — conditions that a later attempt can succeed past.
 */
const TRANSIENT_PRISMA_CODES = new Set(['P1001', 'P1002', 'P1008', 'P1017', 'P2024', 'P2028', 'P2034']);
const TRANSIENT_API_CODES = new Set<string>([ErrorCode.CONFLICT, ErrorCode.DEPENDENCY_UNAVAILABLE, ErrorCode.INTERNAL_ERROR]);

export function classifyCancellationFailure(err: unknown): CancellationFailureKind {
  if (isDispatchedReservationRejection(err)) return 'DISPATCHED';
  if (err instanceof ApiException) return TRANSIENT_API_CODES.has(err.code) ? 'TRANSIENT' : 'PERMANENT';
  if (isSerializationConflict(err)) return 'TRANSIENT';
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && TRANSIENT_PRISMA_CODES.has(code)) return 'TRANSIENT';
  // Anything else is not a domain answer (those are ApiExceptions): treat it as transient, so it is
  // retried — but only up to the attempt budget, after which it is flagged for attention.
  return 'TRANSIENT';
}

/** A short, structured, id-free code for `lastErrorCode` and logs: the ApiException/Prisma code, else `UNKNOWN`. */
export function cancellationFailureCode(err: unknown): string {
  if (err instanceof ApiException) return err.code;
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[A-Z0-9_]{2,64}$/.test(code) ? code : 'UNKNOWN';
}
