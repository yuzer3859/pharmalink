import { PrescriptionMatchingErrors } from '../../domain/errors';
import { IUnitOfWork } from '../ports/unit-of-work.port';

/**
 * Bounded-retry wrapper for every Module 05 mutation transaction (module-05 §2.1.1, §8.1, §12,
 * ADR-013) — Module 05's own copy of Module 03's `runWithDedupRetry`
 * (`modules/catalog/application/support/dedup-conflict.ts`) / Module 02's
 * `runWithDefaultAddressRetry` (`modules/profiles/application/support/default-address-conflict.ts`)
 * pattern, per ADR-002's "own copy per module" discipline — not a cross-module import.
 *
 * §2.1.1 is binding: every Module 05 mutation command that writes state + an
 * `AuditService.record(..., tx)` call + an outbox event in one transaction must run that
 * transaction at `Serializable` isolation (via this module's own `IUnitOfWork`/`PrismaUnitOfWork`,
 * not built here) with this bounded-retry wrapper. This applies to `UploadPrescriptionCommand`,
 * `ApprovePrescriptionCommand`, `RejectPrescriptionCommand`, `RequestClarificationCommand`,
 * `DispenseMedicineCommand`, `FindMatchCommand`, `SelectMatchCommand`, and `RematchCommand`
 * (§2.1.1, §8.1, §8.3, §12) — none of those commands are implemented here; this file is purely
 * the reusable retry infrastructure they will each call.
 *
 * Unlike Catalog's `dedup-conflict.ts`, Module 05 has no dedup-style unique-index race to retry
 * here — the dispense idempotency key (§6.3) is a **replay**, not a conflict, and is handled by
 * the command's own idempotency check inside the transaction, never by retrying. The only
 * retryable condition for this module is the `Serializable` write-conflict/deadlock itself
 * (§8.1 step 10, §2.1.1): a genuine concurrent write-write conflict on the same
 * `PrescriptionLine`/`MatchRequest` row, which Postgres resolves by aborting one side.
 */

/** Bounded to avoid unbounded contention loops, matching Modules 02/03's own budget (§2.1.1). */
export const TRANSACTION_RETRY_MAX_ATTEMPTS = 5;

interface PrismaLikeError {
  code?: unknown;
  message?: unknown;
}

/**
 * True when `err` is a Postgres write-conflict/deadlock raised by running the mutation
 * transaction at `Serializable` isolation (§2.1.1, §8.1 step 10) — Prisma's `P2034`
 * ("Transaction failed due to a write conflict or a deadlock. Please retry your transaction"),
 * or the underlying raw SQLSTATEs `40001` (serialization_failure) / `40P01`
 * (deadlock_detected) when Prisma cannot map them.
 */
export function isSerializationConflict(err: unknown): boolean {
  if (!err || typeof err !== 'object') {
    return false;
  }
  const code = (err as PrismaLikeError).code;
  return code === 'P2034' || code === '40001' || code === '40P01';
}

/**
 * Union of every conflict this module's retry wrapper knows how to retry. Currently just
 * {@link isSerializationConflict} (see the module doc comment for why there is no dedup-style
 * unique-violation branch here, unlike Catalog/Profiles).
 */
export function isRetryableTransactionConflict(err: unknown): boolean {
  return isSerializationConflict(err);
}

/**
 * Runs a mutation closure inside `uow.run`, retrying it — from the beginning, against a fresh
 * `Serializable` transaction and freshly re-read/committed state — whenever a
 * {@link isRetryableTransactionConflict} is raised. Any other error (a permanent
 * application/domain error, e.g. `PRESCRIPTION_EXHAUSTED`, `INVALID_MATCH_STATE_TRANSITION`) is
 * rethrown unchanged and unwrapped, never retried. If contention is not resolved within
 * {@link TRANSACTION_RETRY_MAX_ATTEMPTS}, a deterministic `CONFLICT` (409) is thrown instead of
 * letting the underlying error surface as an unhandled `500` (§8.1 step 10, §15.2).
 *
 * Every Module 05 mutation command (§2.1.1) must go through this wrapper rather than calling
 * `uow.run` directly.
 */
export async function runWithMatchRetry<T>(
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
  throw PrescriptionMatchingErrors.concurrentModification(
    (lastError as PrismaLikeError | undefined)?.message
      ? { cause: String((lastError as PrismaLikeError).message) }
      : undefined,
  );
}
