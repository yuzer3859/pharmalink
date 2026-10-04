import { CatalogErrors } from '../../domain/errors';
import { IUnitOfWork } from '../ports/unit-of-work.port';

/**
 * Concurrency handling for every Catalog mutation transaction (module-03 §9, mirroring
 * `modules/profiles/application/support/default-address-conflict.ts`'s
 * DEFECT-PROFILES-001/002 fix).
 *
 * Two independent sources of write-conflict are retried here:
 *
 * 1. The medicine dedup partial unique index `products_medicine_dedup_key` (§6.2). Two admins
 *    creating/editing the same medicine concurrently can both pass their in-transaction
 *    pre-check and then race to commit; the index lets exactly one win and raises a
 *    unique-constraint violation on the loser's transaction.
 * 2. Every mutation writes its audit entry in the SAME transaction as the state change and
 *    outbox event (ADR-010), so the "no fork" guarantee for the hash chain requires every
 *    mutation transaction to run at Serializable isolation — concurrent transactions that would
 *    otherwise both read the same "last hash" instead abort with a write-conflict.
 *
 * The loser must re-evaluate against the now-committed state and retry — never surface an
 * unhandled `500` (module-03 §11 edge case 5).
 */
export const PRODUCT_DEDUP_INDEX = 'products_medicine_dedup_key';

/** Bounded to avoid unbounded contention loops; a 2-way race resolves within a single retry. */
export const TRANSACTION_RETRY_MAX_ATTEMPTS = 5;

interface PrismaLikeError {
  code?: unknown;
  message?: unknown;
  meta?: { target?: unknown } | undefined;
}

/** True when `err` is the unique-constraint violation raised by the medicine dedup partial index. */
export function isDedupUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== 'object') {
    return false;
  }
  const e = err as PrismaLikeError;
  const code = typeof e.code === 'string' ? e.code : undefined;
  const message = typeof e.message === 'string' ? e.message : '';

  if (message.includes(PRODUCT_DEDUP_INDEX)) {
    return true;
  }
  if (code === '23505') {
    // Raw Postgres unique_violation (surfaced when Prisma cannot map the partial index).
    return true;
  }
  if (code !== 'P2002') {
    return false;
  }

  const target = e.meta?.target;
  if (typeof target === 'string') {
    return target.includes(PRODUCT_DEDUP_INDEX) || target.includes('manufacturerId');
  }
  if (Array.isArray(target)) {
    return target.some((t) => typeof t === 'string' && t.includes('manufacturerId'));
  }
  // P2002 with no attributable target: within a product-mutation closure this can only be the
  // dedup index (the primary key uses a fresh UUID; `manufacturers.name` is a separate flow).
  return true;
}

/** Postgres write-conflict/deadlock raised by Serializable isolation. */
export function isSerializationConflict(err: unknown): boolean {
  if (!err || typeof err !== 'object') {
    return false;
  }
  const code = (err as PrismaLikeError).code;
  return code === 'P2034' || code === '40001' || code === '40P01';
}

export function isRetryableTransactionConflict(err: unknown): boolean {
  return isDedupUniqueViolation(err) || isSerializationConflict(err);
}

/**
 * Runs a mutation closure inside `uow.run`, retrying it against freshly re-read/committed state
 * whenever a {@link isRetryableTransactionConflict} is raised. Any other error is rethrown
 * unchanged. If contention is not resolved within {@link TRANSACTION_RETRY_MAX_ATTEMPTS}, a
 * deterministic `CONFLICT` (409) is returned instead of a `500`.
 */
export async function runWithDedupRetry<T>(
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
  throw CatalogErrors.concurrentModification(
    (lastError as PrismaLikeError | undefined)?.message
      ? { cause: String((lastError as PrismaLikeError).message) }
      : undefined,
  );
}
