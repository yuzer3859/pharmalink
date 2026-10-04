import { OrdersErrors } from '../../domain/errors';
import { IUnitOfWork } from '../ports/unit-of-work.port';

/**
 * Bounded-retry wrapper for every Module 06 mutation transaction that co-locates a state change
 * with an `AuditService.record(..., tx)` call and an outbox write (module-06 `06-orders-spec.md`
 * §11, ADR-013) — this module's own copy of `modules/prescription-matching/application/support/
 * match-retry.ts`'s `runWithMatchRetry` pattern, per ADR-002's "own copy per module" discipline
 * (§11's explicit instruction), not a cross-module import.
 *
 * Applies to `CancelOrderCommand`, `AcceptFulfillmentCommand`, `DeclineFulfillmentCommand`,
 * `PrepareFulfillmentCommand`, `MarkReadyCommand` (§11's table) — `CheckoutCommand` is out of
 * scope for this task (§13/§14).
 */

/** Bounded to avoid unbounded contention loops, matching module-05's own budget (§11). */
export const TRANSACTION_RETRY_MAX_ATTEMPTS = 5;

interface PrismaLikeError {
  code?: unknown;
  message?: unknown;
}

/**
 * True when `err` is a Postgres write-conflict/deadlock raised by running the mutation
 * transaction at `Serializable` isolation (§11) — Prisma's `P2034` ("Transaction failed due to a
 * write conflict or a deadlock. Please retry your transaction"), or the underlying raw SQLSTATEs
 * `40001` (serialization_failure) / `40P01` (deadlock_detected) when Prisma cannot map them.
 */
export function isSerializationConflict(err: unknown): boolean {
  if (!err || typeof err !== 'object') {
    return false;
  }
  const code = (err as PrismaLikeError).code;
  return code === 'P2034' || code === '40001' || code === '40P01';
}

/** Union of every conflict this module's retry wrapper knows how to retry — currently just
 * {@link isSerializationConflict} (mirrors module-05's own "no dedup-style unique-violation
 * branch here" precedent — `Order.idempotencyKey`'s replay handling belongs to `CheckoutCommand`,
 * out of scope for this task). */
export function isRetryableTransactionConflict(err: unknown): boolean {
  return isSerializationConflict(err);
}

/**
 * Runs a mutation closure inside `uow.run`, retrying it — from the beginning, against a fresh
 * `Serializable` transaction and freshly re-read/committed state — whenever a
 * {@link isRetryableTransactionConflict} is raised. Any other error (a permanent
 * application/domain error, e.g. `CANCELLATION_NOT_ALLOWED`, `INVALID_ORDER_STATE_TRANSITION`) is
 * rethrown unchanged and unwrapped, never retried. If contention is not resolved within
 * {@link TRANSACTION_RETRY_MAX_ATTEMPTS}, a deterministic `CONFLICT` (409) is thrown instead of
 * letting the underlying error surface as an unhandled `500` (§11).
 */
export async function runWithOrderRetry<T>(
  uow: IUnitOfWork,
  work: (tx: unknown) => Promise<T>,
  maxAttempts: number = TRANSACTION_RETRY_MAX_ATTEMPTS,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await uow.run(work);
    } catch (err) {
      if (!isRetryableTransactionConflict(err)) {
        throw err;
      }
      lastError = err;
    }
  }
  throw OrdersErrors.concurrentModification(
    (lastError as PrismaLikeError | undefined)?.message
      ? { cause: String((lastError as PrismaLikeError).message) }
      : undefined,
  );
}
