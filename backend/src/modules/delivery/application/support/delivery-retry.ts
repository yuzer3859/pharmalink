import { ApiException } from '../../../../shared/errors/api-exception';
import { ErrorCode } from '../../../../shared/errors/error-codes';
import { IUnitOfWork } from '../ports/unit-of-work.port';

/**
 * Bounded-retry wrapper for every Module 08 mutation transaction that co-locates a state change
 * with an `AuditService.record(..., tx)` call and an outbox write (ADR-013) — this module's own
 * copy of `modules/orders/application/support/order-retry.ts` and its Module 05/07 siblings, per
 * ADR-002's "own copy per module" discipline, not a cross-module import.
 *
 * **A retried closure must contain no external side effect.** Every transaction this wraps is
 * pure local persistence; the cross-module reads that build a delivery job deliberately sit
 * outside it (see `CreateDeliveryJobCommand.buildJob`), which is ADR-014's discipline and also
 * what makes a serialization retry free of consequence.
 */
export const TRANSACTION_RETRY_MAX_ATTEMPTS = 5;

interface PrismaLikeError {
  code?: unknown;
  message?: unknown;
}

/**
 * True when `err` is a Postgres write-conflict/deadlock raised by running at `Serializable`
 * isolation — Prisma's `P2034`, or the raw SQLSTATEs `40001` (serialization_failure) / `40P01`
 * (deadlock_detected) when Prisma cannot map them.
 */
export function isSerializationConflict(err: unknown): boolean {
  if (!err || typeof err !== 'object') {
    return false;
  }
  const code = (err as PrismaLikeError).code;
  return code === 'P2034' || code === '40001' || code === '40P01';
}

/** Prisma's unique-constraint violation — `delivery_jobs.fulfillmentId`'s DB-level backstop. */
export function isUniqueConstraintViolation(err: unknown): boolean {
  return Boolean(err && typeof err === 'object' && (err as PrismaLikeError).code === 'P2002');
}

/**
 * Runs a mutation closure inside `uow.run`, retrying it from the beginning against a fresh
 * `Serializable` transaction whenever a serialization conflict is raised. Any other error — a
 * domain error, or the `P2002` idempotency race the caller handles itself — is rethrown
 * unchanged and never retried. Exhausting the budget yields a deterministic `CONFLICT` rather
 * than an unhandled 500.
 */
export async function runWithDeliveryRetry<T>(
  uow: IUnitOfWork,
  work: (tx: unknown) => Promise<T>,
  maxAttempts: number = TRANSACTION_RETRY_MAX_ATTEMPTS,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await uow.run(work);
    } catch (err) {
      if (!isSerializationConflict(err)) {
        throw err;
      }
      lastError = err;
    }
  }
  throw new ApiException(
    ErrorCode.CONFLICT,
    'This delivery record was changed concurrently by another request. Please retry.',
    (lastError as PrismaLikeError | undefined)?.message
      ? { cause: String((lastError as PrismaLikeError).message) }
      : undefined,
  );
}
