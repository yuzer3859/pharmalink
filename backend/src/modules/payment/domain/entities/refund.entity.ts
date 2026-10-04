import { RefundDestination, RefundStatus, RefundType } from '../enums';
import { PaymentErrors } from '../errors';
import { RefundStatusPolicy } from '../services/refund-status-policy';
import { Currency } from '../value-objects/currency.vo';
import { IdempotencyKey } from '../value-objects/idempotency-key.vo';
import { Money } from '../value-objects/money.vo';

/**
 * Persisted shape of the `Refund` entity (§5.1, §7 `refunds`) — every column of that table and
 * no more.
 *
 * **PCI boundary (BRULE-26, NFR-SEC-04): there is no `pan`, `cardNumber`, `cvv`, `expiry` or
 * cardholder field here, and there never may be.** A refund to the original method is addressed
 * by the gateway's own `providerRef`, never by re-presenting an instrument — which is precisely
 * why refunding to the original method needs no card data at all.
 *
 * ## Why there is no `currency` column
 *
 * §7's `refunds` has none, and this deliberately does not add one. A refund's currency *is* its
 * payment's currency: introducing a second copy would create a value that could disagree with
 * `payments.currency`, and a mismatch between the two would be a money bug nobody could resolve
 * from the data. `RefundPolicy` rejects any request whose currency differs from the payment's, so
 * the constraint is enforced where it can be enforced rather than stored where it could rot.
 */
export interface RefundProps {
  id: string;
  paymentId: string;
  /** Refunded amount in the payment's currency, integer minor units (ADR-005). */
  amount: number;
  reason: string | null;
  type: RefundType;
  destination: RefundDestination;
  status: RefundStatus;
  /** The gateway's own reference for the refund, once it issues one. */
  providerRef: string | null;
  /**
   * The human who authorized a manual/admin refund (§3.2 F-RFD-03, §9.3 "Manual/admin refunds
   * require `finance:refund:any` + audit"). `null` for a system/saga-driven refund, which has no
   * human approver — recording a fabricated one would corrupt the audit trail this field exists
   * to serve.
   */
  approvedBy: string | null;
  idempotencyKey: string;
  createdAt: Date;
  completedAt: Date | null;
}

export interface NewRefundProps {
  paymentId: string;
  /** Already validated against the remaining refundable amount by `RefundPolicy`. */
  amount: Money;
  /** `FULL` when this refund exhausts the remaining refundable amount, else `PARTIAL`. */
  type: RefundType;
  destination: RefundDestination;
  reason?: string | null;
  approvedBy?: string | null;
  idempotencyKey: string | IdempotencyKey;
}

const MAX_REASON_LENGTH = 512;
const MAX_APPROVER_LENGTH = 128;

/**
 * `Refund` (§5.1's entity list, §7 `refunds`, §11.4) — one refund against one payment.
 *
 * Framework-free: no Prisma, no Nest, no HTTP. Like `Payment`, transitions are the only way
 * `status` changes and each runs through `RefundStatusPolicy` before a field is touched, so a
 * refund can never be left in a state the design does not describe. `completedAt` is written by
 * the transition that earns it, never independently — a completed refund without a completion
 * timestamp, or the reverse, would be a reconciliation trap.
 *
 * The entity holds **no** ledger knowledge and performs no posting: what a refund debits and
 * credits is `RefundAccountingService`'s composition, enforced by `LedgerService` (§11.4). The
 * over-refund invariant is likewise not here — it spans every refund of a payment, so it belongs
 * to `RefundPolicy` with the totals in hand, not to a single row.
 */
export class Refund {
  private constructor(private props: RefundProps) {}

  static rehydrate(props: RefundProps): Refund {
    return new Refund({ ...props });
  }

  /**
   * Opens a refund in `PENDING` — the persisted *intent*, written before any gateway call so the
   * external step is recoverable (see `RefundPaymentCommand`). The caller supplies the id (UUID),
   * mirroring `Payment.initiate(id, ...)`.
   */
  static create(id: string, input: NewRefundProps, now: Date = new Date()): Refund {
    const refundId = requireText(id, 'id');
    const paymentId = requireText(input.paymentId, 'paymentId');

    if (!Object.values(RefundType).includes(input.type)) {
      throw PaymentErrors.validation('Unknown refund type.', { field: 'type', value: input.type });
    }
    if (!Object.values(RefundDestination).includes(input.destination)) {
      throw PaymentErrors.validation('Unknown refund destination.', {
        field: 'destination',
        value: input.destination,
      });
    }

    // Positivity lives here as well as in `RefundPolicy` and in the database's own
    // `refunds_amount_positive_check`: a zero refund records nothing, and a negative one is a
    // charge wearing a refund's name.
    input.amount.assertPersistable('amount');
    if (!input.amount.isPositive) {
      throw PaymentErrors.validation('A refund amount must be a positive integer (minor units).', {
        field: 'amount',
        value: input.amount.amountMinor,
      });
    }

    const idempotencyKey =
      input.idempotencyKey instanceof IdempotencyKey
        ? input.idempotencyKey
        : IdempotencyKey.of(input.idempotencyKey);

    return new Refund({
      id: refundId,
      paymentId,
      amount: input.amount.amountMinor,
      reason: optionalText(input.reason, 'reason', MAX_REASON_LENGTH),
      type: input.type,
      destination: input.destination,
      status: RefundStatus.PENDING,
      providerRef: null,
      approvedBy: optionalText(input.approvedBy, 'approvedBy', MAX_APPROVER_LENGTH),
      idempotencyKey: idempotencyKey.value,
      createdAt: now,
      completedAt: null,
    });
  }

  get id(): string {
    return this.props.id;
  }
  get paymentId(): string {
    return this.props.paymentId;
  }
  get type(): RefundType {
    return this.props.type;
  }
  get destination(): RefundDestination {
    return this.props.destination;
  }
  get status(): RefundStatus {
    return this.props.status;
  }
  get providerRef(): string | null {
    return this.props.providerRef;
  }
  get approvedBy(): string | null {
    return this.props.approvedBy;
  }
  get idempotencyKey(): string {
    return this.props.idempotencyKey;
  }
  get completedAt(): Date | null {
    return this.props.completedAt;
  }
  get isTerminal(): boolean {
    return RefundStatusPolicy.isTerminal(this.props.status);
  }

  /** Raw minor units, for callers that already know the payment's currency. */
  get amountMinor(): number {
    return this.props.amount;
  }

  /** The refunded amount, in the currency the caller resolved from the payment (see the props doc). */
  amountIn(currency: string | Currency): Money {
    return Money.of(this.props.amount, currency);
  }

  /**
   * The money has moved: the gateway confirmed an `ORIGINAL` refund, or the `WALLET` credit was
   * posted. `completedAt` is set by this transition and by nothing else.
   */
  complete(now: Date = new Date(), providerRef?: string | null): void {
    this.transitionTo(RefundStatus.COMPLETED);
    this.props.completedAt = now;
    if (providerRef !== undefined) {
      this.props.providerRef = providerRef;
    }
  }

  /**
   * The gateway positively declined the refund. No money moved, so no ledger posting is made and
   * the amount becomes refundable again (`RefundStatusPolicy.countsAgainstRefundedTotal`).
   *
   * Reserved for a *positive* decline. An ambiguous outcome must leave the refund `PENDING` — see
   * `RefundPaymentCommand`'s ambiguity rule.
   */
  fail(providerRef?: string | null): void {
    this.transitionTo(RefundStatus.FAILED);
    if (providerRef !== undefined) {
      this.props.providerRef = providerRef;
    }
  }

  toProps(): RefundProps {
    return { ...this.props };
  }

  private transitionTo(next: RefundStatus): void {
    RefundStatusPolicy.assertValidTransition(this.props.status, next);
    this.props.status = next;
  }
}

function requireText(value: string, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw PaymentErrors.validation(`${field} is required.`, { field });
  }
  return value.trim();
}

function optionalText(
  value: string | null | undefined,
  field: string,
  maxLength: number,
): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== 'string') {
    throw PaymentErrors.validation(`${field} must be a string when present.`, { field });
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }
  if (trimmed.length > maxLength) {
    throw PaymentErrors.validation(`${field} must be at most ${maxLength} characters.`, { field });
  }
  return trimmed;
}
