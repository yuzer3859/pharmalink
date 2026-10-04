import { ProfileErrors } from '../../domain/errors';
import { IUnitOfWork } from '../ports/unit-of-work.port';

/**
 * Concurrency handling for every Profile/Address mutation transaction.
 *
 * Two independent sources of write-conflict are retried here:
 *
 * 1. DEFECT-PROFILES-001 — the "exactly one default address" invariant, enforced by the
 *    Postgres partial unique index `addresses_one_default_per_user` (module-02 §6.3). Two
 *    requests that each try to make a *different* address the default for the same user can
 *    both pass their in-transaction reads and then race to commit `isDefault = true`; the index
 *    lets exactly one win and raises a unique-constraint violation on the loser's transaction.
 * 2. DEFECT-PROFILES-002 / ADR-010 — every mutation now appends an audit entry in the SAME
 *    transaction as the state change and outbox event (see `AuditService.record`,
 *    `PrismaUnitOfWork`). To keep the audit hash chain's "no fork" guarantee without a second,
 *    independent transaction, every mutation transaction runs at Serializable isolation, so
 *    Postgres itself aborts one side of any genuine conflict (e.g. two concurrent mutations for
 *    the same user both reading the same "last hash") with a write-conflict error.
 *
 * Per §6.3 edge case 8 (and, by the same reasoning, the audit-chain conflict), the loser must
 * **re-evaluate against the now-committed state and retry** — never surface an unhandled `500`.
 * Because each retry runs a fresh transaction that re-reads current state from scratch, the
 * operation converges while the database constraints remain the authoritative guard.
 */
export const DEFAULT_ADDRESS_INDEX = 'addresses_one_default_per_user';

/** Bounded to avoid unbounded contention loops; a 2-way race resolves within a single retry. */
export const TRANSACTION_RETRY_MAX_ATTEMPTS = 5;

interface PrismaLikeError {
  code?: unknown;
  message?: unknown;
  meta?: { target?: unknown } | undefined;
}

/**
 * True when `err` is the unique-constraint violation raised by the default-address partial index.
 *
 * Detects both the Prisma-mapped error (`P2002`) and the raw Postgres `unique_violation` (SQLSTATE
 * `23505`) — Prisma does not always surface a `meta.target` for a raw/partial index that is not
 * declared in the schema, so we also match on the index name in the message. Inside the
 * default-swap closures this is the only unique index that can be violated (the primary key uses a
 * fresh UUID), so a bare `P2002` with no usable metadata is still safely attributable to it.
 */
export function isDefaultAddressUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== 'object') {
    return false;
  }
  const e = err as PrismaLikeError;
  const code = typeof e.code === 'string' ? e.code : undefined;
  const message = typeof e.message === 'string' ? e.message : '';

  if (message.includes(DEFAULT_ADDRESS_INDEX)) {
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
    return (
      target.includes(DEFAULT_ADDRESS_INDEX) ||
      target.includes('userId') ||
      target.includes('user_id')
    );
  }
  if (Array.isArray(target)) {
    return target.some(
      (t) => typeof t === 'string' && (t.includes('userId') || t.includes('user_id')),
    );
  }

  // P2002 with no attributable target: within a default-swap closure this can only be the
  // addresses_one_default_per_user index, so treat it as the default-address race.
  return true;
}

/**
 * True when `err` is a Postgres write-conflict/deadlock raised by running the mutation
 * transaction at Serializable isolation (DEFECT-PROFILES-002) — Prisma's `P2034` ("Transaction
 * failed due to a write conflict or a deadlock. Please retry your transaction"), or the
 * underlying raw SQLSTATEs `40001` (serialization_failure) / `40P01` (deadlock_detected) when
 * Prisma cannot map them.
 */
export function isSerializationConflict(err: unknown): boolean {
  if (!err || typeof err !== 'object') {
    return false;
  }
  const code = (err as PrismaLikeError).code;
  return code === 'P2034' || code === '40001' || code === '40P01';
}

/** Union of every conflict this module knows how to retry — see the module doc comment. */
export function isRetryableTransactionConflict(err: unknown): boolean {
  return isDefaultAddressUniqueViolation(err) || isSerializationConflict(err);
}

/**
 * Runs a mutation closure inside `uow.run`, retrying it against freshly re-read/committed state
 * whenever a {@link isRetryableTransactionConflict} is raised. Any other error is rethrown
 * unchanged (never swallowed). If contention is not resolved within
 * {@link TRANSACTION_RETRY_MAX_ATTEMPTS}, a deterministic `CONFLICT` (409) is returned instead of
 * a `500` — still a defined API behavior, and no database invariant is ever weakened.
 *
 * Every Profile/Address command that mutates state (create/update/delete/set-default address,
 * update profile) must go through this wrapper rather than calling `uow.run` directly, since
 * `PrismaUnitOfWork` now always runs at Serializable isolation (DEFECT-PROFILES-002).
 */
export async function runWithDefaultAddressRetry<T>(
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
  throw ProfileErrors.concurrentModification(
    (lastError as PrismaLikeError | undefined)?.message
      ? { cause: String((lastError as PrismaLikeError).message) }
      : undefined,
  );
}
