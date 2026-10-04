import { PaymentErrors } from '../errors';

export const MIN_IDEMPOTENCY_KEY_LENGTH = 8;
export const MAX_IDEMPOTENCY_KEY_LENGTH = 128;

/** Printable ASCII, no whitespace — a replay key travels in headers, logs and unique indexes. */
const PRINTABLE_NO_SPACE = /^[\x21-\x7e]+$/;

/**
 * `IdempotencyKey` (§5.2, §5.3) — the client/caller-supplied replay key that makes every money
 * operation retry-safe (BRULE-25, "replays never double-charge/double-refund").
 *
 * This task establishes the domain primitive and the persistence invariant behind it only:
 * `payments.idempotencyKey` is `@unique`, so the database is the final arbiter of "one key, one
 * payment", exactly as `orders.idempotencyKey` and `stock_reservations.(listingId,
 * idempotencyKey)` already are. The application-level replay flow (look up by key, return the
 * original result, resolve a concurrent-insert race on `P2002`) belongs to the payment-command
 * task, mirroring `CheckoutCommand`/`ReserveStockCommand`.
 *
 * Bounds match Module 06's `CheckoutInput.idempotencyKey` (`@MinLength(8) @MaxLength(128)`) so a
 * key that is valid at the Orders boundary is valid here.
 */
export class IdempotencyKey {
  private constructor(readonly value: string) {}

  static of(raw: string): IdempotencyKey {
    if (typeof raw !== 'string') {
      throw PaymentErrors.validation('idempotencyKey must be a string.', {
        field: 'idempotencyKey',
      });
    }
    const value = raw.trim();
    if (
      value.length < MIN_IDEMPOTENCY_KEY_LENGTH ||
      value.length > MAX_IDEMPOTENCY_KEY_LENGTH
    ) {
      throw PaymentErrors.validation(
        `idempotencyKey must be between ${MIN_IDEMPOTENCY_KEY_LENGTH} and ${MAX_IDEMPOTENCY_KEY_LENGTH} characters.`,
        { field: 'idempotencyKey' },
      );
    }
    if (!PRINTABLE_NO_SPACE.test(value)) {
      throw PaymentErrors.validation(
        'idempotencyKey must contain only printable, non-whitespace ASCII characters.',
        { field: 'idempotencyKey' },
      );
    }
    return new IdempotencyKey(value);
  }

  equals(other: IdempotencyKey): boolean {
    return this.value === other.value;
  }

  toString(): string {
    return this.value;
  }
}
