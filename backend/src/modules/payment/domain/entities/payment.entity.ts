import { PaymentMethod, PaymentStatus } from '../enums';
import { PaymentErrors } from '../errors';
import { PaymentStatusPolicy } from '../services/payment-status-policy';
import { Currency } from '../value-objects/currency.vo';
import { FxRate } from '../value-objects/fx-rate.vo';
import { IdempotencyKey } from '../value-objects/idempotency-key.vo';
import { Money } from '../value-objects/money.vo';

/**
 * Persisted shape of the `Payment` aggregate root (§5.1, §7 `payments`).
 *
 * **PCI boundary (BRULE-26, NFR-SEC-04): there is no `pan`, `cardNumber`, `cvv`, `expiry` or
 * cardholder field here, and there never may be.** The only provider-facing values the platform
 * stores are `providerRef` (the gateway's own transaction reference) and `providerToken` (an
 * opaque token the PCI-DSS-compliant gateway issued *in place of* card data). Both are
 * provider-issued identifiers — they are not, and must not be derived from, card data.
 */
export interface PaymentProps {
  id: string;
  orderId: string;
  customerUserId: string;
  method: PaymentMethod;
  status: PaymentStatus;
  /** Charged/settled amount in ETB minor units (BRULE-22). */
  amount: number;
  currency: string;
  /** Cross-border only (§8): what the customer actually paid, before conversion. */
  originalAmount: number | null;
  originalCurrency: string | null;
  fxRate: number | null;
  fxSource: string | null;
  provider: string | null;
  providerRef: string | null;
  providerToken: string | null;
  idempotencyKey: string;
  authorizedAt: Date | null;
  capturedAt: Date | null;
  failureReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Cross-border capture inputs (§3.1 F-PAY-03, §8): the original foreign amount plus the rate
 * applied to reach ETB. The ETB `amount` is *derived* from these, never supplied alongside them,
 * so the stored conversion is always reproducible from what is stored.
 */
export interface PaymentFxInput {
  originalAmount: Money;
  rate: FxRate;
}

export interface NewPaymentProps {
  orderId: string;
  customerUserId: string;
  method: PaymentMethod;
  /**
   * Domestic payments supply the ETB amount directly; cross-border payments supply `fx` instead
   * and let the recorded rate derive it. Exactly one of the two is required.
   */
  amount?: Money;
  fx?: PaymentFxInput;
  idempotencyKey: string | IdempotencyKey;
  /** Gateway key (`telebirr`, `cbe`, …). Unset until a provider adapter exists. */
  provider?: string | null;
  /** Opaque, PCI-safe token issued by the gateway. Never card data. */
  providerToken?: string | null;
}

const MAX_FAILURE_REASON_LENGTH = 512;

function assertNonEmpty(value: string, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw PaymentErrors.validation(`${field} is required.`, { field });
  }
  return value.trim();
}

/**
 * `Payment` aggregate root (§5.1) — one payment attempt for one order, and the owner of the §6
 * state machine. Framework-free: no Prisma, no Nest, no HTTP.
 *
 * Transitions are the *only* way `status` changes, and each one runs through
 * `PaymentStatusPolicy` before any field is touched, so an aggregate can never be left in a
 * state the design does not allow. Timestamps (`authorizedAt`, `capturedAt`) are written by the
 * transition that earns them, never set independently.
 */
export class Payment {
  private constructor(private props: PaymentProps) {}

  static rehydrate(props: PaymentProps): Payment {
    return new Payment({ ...props });
  }

  /**
   * Opens a new payment attempt in `INITIATED` (§6's entry state). The caller supplies the id
   * (UUID), mirroring `Product.create(id, …)` / `NewReservationInput.id`'s convention.
   */
  static initiate(id: string, input: NewPaymentProps, now: Date = new Date()): Payment {
    const paymentId = assertNonEmpty(id, 'id');
    const orderId = assertNonEmpty(input.orderId, 'orderId');
    const customerUserId = assertNonEmpty(input.customerUserId, 'customerUserId');

    if (!Object.values(PaymentMethod).includes(input.method)) {
      throw PaymentErrors.validation('Unknown payment method.', {
        field: 'method',
        value: input.method,
      });
    }

    if ((input.amount === undefined) === (input.fx === undefined)) {
      throw PaymentErrors.validation(
        'Exactly one of amount (domestic) or fx (cross-border) must be supplied.',
        { field: 'amount' },
      );
    }

    // Every payment is recorded in ETB (BRULE-22); a cross-border payment derives its ETB amount
    // from the captured rate so the conversion stays reproducible from the stored row (§8).
    const amount = input.fx
      ? input.fx.rate.convert(input.fx.originalAmount, Currency.base())
      : (input.amount as Money);
    amount.currency.assertBase('currency');
    amount.assertPersistable('amount');
    if (!amount.isPositive) {
      throw PaymentErrors.validation('amount must be a positive integer (minor units).', {
        field: 'amount',
        value: amount.amountMinor,
      });
    }
    if (input.fx) {
      input.fx.originalAmount.assertPersistable('originalAmount');
      if (!input.fx.originalAmount.isPositive) {
        throw PaymentErrors.validation('originalAmount must be a positive integer (minor units).', {
          field: 'originalAmount',
          value: input.fx.originalAmount.amountMinor,
        });
      }
    }

    const idempotencyKey =
      input.idempotencyKey instanceof IdempotencyKey
        ? input.idempotencyKey
        : IdempotencyKey.of(input.idempotencyKey);

    return new Payment({
      id: paymentId,
      orderId,
      customerUserId,
      method: input.method,
      status: PaymentStatus.INITIATED,
      amount: amount.amountMinor,
      currency: amount.currency.code,
      originalAmount: input.fx ? input.fx.originalAmount.amountMinor : null,
      originalCurrency: input.fx ? input.fx.originalAmount.currency.code : null,
      fxRate: input.fx ? input.fx.rate.rate : null,
      fxSource: input.fx ? input.fx.rate.source : null,
      provider: input.provider ?? null,
      providerRef: null,
      providerToken: input.providerToken ?? null,
      idempotencyKey: idempotencyKey.value,
      authorizedAt: null,
      capturedAt: null,
      failureReason: null,
      createdAt: now,
      updatedAt: now,
    });
  }

  get id(): string {
    return this.props.id;
  }
  get orderId(): string {
    return this.props.orderId;
  }
  get customerUserId(): string {
    return this.props.customerUserId;
  }
  get method(): PaymentMethod {
    return this.props.method;
  }
  get status(): PaymentStatus {
    return this.props.status;
  }
  get idempotencyKey(): string {
    return this.props.idempotencyKey;
  }
  get providerRef(): string | null {
    return this.props.providerRef;
  }
  get authorizedAt(): Date | null {
    return this.props.authorizedAt;
  }
  get capturedAt(): Date | null {
    return this.props.capturedAt;
  }
  get failureReason(): string | null {
    return this.props.failureReason;
  }
  get isTerminal(): boolean {
    return PaymentStatusPolicy.isTerminal(this.props.status);
  }

  /** The settled ETB amount (BRULE-22). */
  get amount(): Money {
    return Money.of(this.props.amount, this.props.currency);
  }

  /** What the customer paid in their own currency, for a cross-border payment (§8). */
  get originalAmount(): Money | null {
    return this.props.originalAmount === null || this.props.originalCurrency === null
      ? null
      : Money.of(this.props.originalAmount, this.props.originalCurrency);
  }

  /** Funds held by the provider; Orders may confirm the order (BRULE-17, §6). */
  authorize(now: Date = new Date(), providerRef?: string | null): void {
    this.transitionTo(PaymentStatus.AUTHORIZED, now);
    this.props.authorizedAt = now;
    if (providerRef !== undefined) {
      this.props.providerRef = providerRef;
    }
  }

  /**
   * Money collected at fulfillment (§6, §11.3) — the ledger posting is `LedgerService`'s job,
   * not the aggregate's.
   */
  capture(now: Date = new Date(), providerRef?: string | null): void {
    this.transitionTo(PaymentStatus.CAPTURED, now);
    this.props.capturedAt = now;
    if (providerRef !== undefined) {
      this.props.providerRef = providerRef;
    }
  }

  /** Included in a provider payout batch (BRULE-23, §11.5). */
  settle(now: Date = new Date()): void {
    this.transitionTo(PaymentStatus.SETTLED, now);
  }

  fail(reason: string, now: Date = new Date()): void {
    const failureReason = assertNonEmpty(reason, 'failureReason');
    if (failureReason.length > MAX_FAILURE_REASON_LENGTH) {
      throw PaymentErrors.validation(
        `failureReason must be at most ${MAX_FAILURE_REASON_LENGTH} characters.`,
        { field: 'failureReason' },
      );
    }
    this.transitionTo(PaymentStatus.FAILED, now);
    this.props.failureReason = failureReason;
  }

  /** Authorization cancelled before capture — the hold is released and nothing is charged (§6). */
  voidAuthorization(now: Date = new Date()): void {
    this.transitionTo(PaymentStatus.VOIDED, now);
  }

  /** The authorization lapsed before it could be captured (§6 `EXPIRED`). */
  expire(now: Date = new Date()): void {
    this.transitionTo(PaymentStatus.EXPIRED, now);
  }

  /**
   * BRULE-24. The `Refund` entity, its eligibility checks and its ledger postings belong to the
   * refund task; this is only the aggregate's own status transition.
   */
  markRefunded(now: Date = new Date()): void {
    this.transitionTo(PaymentStatus.REFUNDED, now);
  }

  markPartiallyRefunded(now: Date = new Date()): void {
    this.transitionTo(PaymentStatus.PARTIALLY_REFUNDED, now);
  }

  toProps(): PaymentProps {
    return { ...this.props };
  }

  private transitionTo(next: PaymentStatus, now: Date): void {
    PaymentStatusPolicy.assertValidTransition(this.props.status, next);
    this.props.status = next;
    this.props.updatedAt = now;
  }
}
