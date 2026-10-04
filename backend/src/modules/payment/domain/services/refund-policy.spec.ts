import { ApiException } from '../../../../shared/errors/api-exception';
import { ErrorCode } from '../../../../shared/errors/error-codes';
import { PaymentProps } from '../entities/payment.entity';
import { Refund } from '../entities/refund.entity';
import {
  PaymentMethod,
  PaymentStatus,
  RefundDestination,
  RefundStatus,
  RefundType,
} from '../enums';
import { Money } from '../value-objects/money.vo';
import { RefundPolicy } from './refund-policy';
import { REFUNDED_TOTAL_STATUSES, RefundStatusPolicy } from './refund-status-policy';

function payment(overrides: Partial<PaymentProps> = {}): PaymentProps {
  const now = new Date();
  return {
    id: 'payment-1',
    orderId: 'order-1',
    customerUserId: 'customer-1',
    method: PaymentMethod.TELEBIRR,
    status: PaymentStatus.CAPTURED,
    amount: 10_000,
    currency: 'ETB',
    originalAmount: null,
    originalCurrency: null,
    fxRate: null,
    fxSource: null,
    provider: 'mock',
    providerRef: 'ref-1',
    providerToken: null,
    idempotencyKey: 'pay-key-1',
    authorizedAt: now,
    capturedAt: now,
    failureReason: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function classify(input: {
  status?: PaymentStatus;
  alreadyRefunded?: number;
  requested?: number | null;
  destination?: RefundDestination;
}) {
  return RefundPolicy.classify({
    payment: payment({ status: input.status ?? PaymentStatus.CAPTURED }),
    alreadyRefunded: Money.of(input.alreadyRefunded ?? 0, 'ETB'),
    requestedAmount: input.requested === undefined ? null : input.requested === null ? null : Money.of(input.requested, 'ETB'),
    destination: input.destination ?? RefundDestination.ORIGINAL,
  });
}

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (err) {
    if (err instanceof ApiException) {
      return err.code;
    }
    throw err;
  }
  throw new Error('expected the operation to be rejected');
}

describe('RefundPolicy (BRULE-24)', () => {
  it('treats an omitted amount as the whole remaining refundable amount', () => {
    expect(classify({}).amount.amountMinor).toBe(10_000);
    // Not the original capture: refunding that again after a partial would over-refund.
    expect(classify({ alreadyRefunded: 4_000 }).amount.amountMinor).toBe(6_000);
  });

  it('classifies by the remainder, not by the original capture', () => {
    expect(classify({ requested: 10_000 }).type).toBe(RefundType.FULL);
    expect(classify({ requested: 9_999 }).type).toBe(RefundType.PARTIAL);
    // The refund that closes out a partially refunded payment is a FULL one.
    expect(classify({ alreadyRefunded: 6_000, requested: 4_000 }).type).toBe(RefundType.FULL);
    expect(classify({ alreadyRefunded: 6_000, requested: 3_999 }).type).toBe(RefundType.PARTIAL);
  });

  it('reports the remaining amount before and after the refund', () => {
    const result = classify({ alreadyRefunded: 2_500, requested: 1_500 });
    expect(result.remainingBefore.amountMinor).toBe(7_500);
    expect(result.remainingAfter.amountMinor).toBe(6_000);
  });

  it('permits a refund only from CAPTURED and PARTIALLY_REFUNDED', () => {
    expect(RefundPolicy.refundableStatuses().sort()).toEqual(
      [PaymentStatus.CAPTURED, PaymentStatus.PARTIALLY_REFUNDED].sort(),
    );
    for (const status of Object.values(PaymentStatus)) {
      const refundable = RefundPolicy.isRefundableStatus(status);
      expect(refundable).toBe(
        status === PaymentStatus.CAPTURED || status === PaymentStatus.PARTIALLY_REFUNDED,
      );
    }
  });

  it.each([
    PaymentStatus.INITIATED,
    PaymentStatus.AUTHORIZED,
    PaymentStatus.VOIDED,
    PaymentStatus.FAILED,
    PaymentStatus.EXPIRED,
    PaymentStatus.REFUNDED,
    PaymentStatus.SETTLED,
  ])('rejects a refund of a %s payment before it does any arithmetic', (status) => {
    expect(codeOf(() => classify({ status, requested: 1 }))).toBe(ErrorCode.REFUND_NOT_ELIGIBLE);
  });

  it('rejects an amount beyond the remainder', () => {
    expect(codeOf(() => classify({ requested: 10_001 }))).toBe(ErrorCode.REFUND_EXCEEDS_CAPTURED);
    expect(codeOf(() => classify({ alreadyRefunded: 9_000, requested: 1_001 }))).toBe(
      ErrorCode.REFUND_EXCEEDS_CAPTURED,
    );
  });

  it('accepts an amount exactly equal to the remainder', () => {
    expect(classify({ alreadyRefunded: 9_000, requested: 1_000 }).remainingAfter.isZero).toBe(true);
  });

  it.each([0, -1])('rejects a %s amount', (amount) => {
    expect(codeOf(() => classify({ requested: amount }))).toBe(ErrorCode.VALIDATION_ERROR);
  });

  it('rejects a refund in a currency other than the payment currency', () => {
    expect(
      codeOf(() =>
        RefundPolicy.classify({
          payment: payment(),
          alreadyRefunded: Money.of(0, 'ETB'),
          requestedAmount: Money.of(1_000, 'USD'),
          destination: RefundDestination.ORIGINAL,
        }),
      ),
    ).toBe(ErrorCode.VALIDATION_ERROR);
  });

  it('rejects an unknown destination', () => {
    expect(
      codeOf(() => classify({ requested: 100, destination: 'BANK' as RefundDestination })),
    ).toBe(ErrorCode.VALIDATION_ERROR);
  });

  it('treats an already-refunded total exceeding the capture as a ledger defect, not a clamp', () => {
    // Reaching this means the over-refund guard was already breached upstream — surfacing it as a
    // 500-mapped LEDGER_UNBALANCED is deliberate; silently clamping to zero would hide it.
    expect(
      codeOf(() => RefundPolicy.remainingRefundable(payment(), Money.of(10_001, 'ETB'))),
    ).toBe(ErrorCode.LEDGER_UNBALANCED);
  });
});

describe('RefundStatusPolicy', () => {
  it('allows only the two transitions §11.4 actually performs', () => {
    expect(RefundStatusPolicy.legalTransitionsFrom(RefundStatus.PENDING).sort()).toEqual(
      [RefundStatus.COMPLETED, RefundStatus.FAILED].sort(),
    );
    expect(RefundStatusPolicy.isTerminal(RefundStatus.COMPLETED)).toBe(true);
    expect(RefundStatusPolicy.isTerminal(RefundStatus.FAILED)).toBe(true);
  });

  it('leaves APPROVED unreachable — the design defines no two-step approval workflow', () => {
    expect(RefundStatusPolicy.legalTransitionsFrom(RefundStatus.APPROVED)).toEqual([]);
    for (const from of Object.values(RefundStatus)) {
      expect(RefundStatusPolicy.isLegalTransition(from, RefundStatus.APPROVED)).toBe(false);
    }
  });

  it('counts every status except FAILED against the refunded total', () => {
    expect(RefundStatusPolicy.countsAgainstRefundedTotal(RefundStatus.FAILED)).toBe(false);
    expect(RefundStatusPolicy.countsAgainstRefundedTotal(RefundStatus.PENDING)).toBe(true);
    expect(RefundStatusPolicy.countsAgainstRefundedTotal(RefundStatus.COMPLETED)).toBe(true);
    expect([...REFUNDED_TOTAL_STATUSES].sort()).toEqual(
      [RefundStatus.PENDING, RefundStatus.APPROVED, RefundStatus.COMPLETED].sort(),
    );
  });

  it('rejects an illegal transition through the entity', () => {
    const refund = Refund.create('refund-1', {
      paymentId: 'payment-1',
      amount: Money.of(1_000, 'ETB'),
      type: RefundType.PARTIAL,
      destination: RefundDestination.ORIGINAL,
      idempotencyKey: 'refund-key-1',
    });
    refund.complete();

    expect(codeOf(() => refund.fail())).toBe(ErrorCode.INVALID_PAYMENT_STATE_TRANSITION);
  });
});

describe('Refund entity', () => {
  const base = {
    paymentId: 'payment-1',
    type: RefundType.PARTIAL,
    destination: RefundDestination.ORIGINAL,
    idempotencyKey: 'refund-key-1',
  };

  it('opens in PENDING with no completion timestamp and no provider reference', () => {
    const refund = Refund.create('refund-1', { ...base, amount: Money.of(1_000, 'ETB') });

    expect(refund.status).toBe(RefundStatus.PENDING);
    expect(refund.completedAt).toBeNull();
    expect(refund.providerRef).toBeNull();
    expect(refund.isTerminal).toBe(false);
  });

  it('writes completedAt only through complete()', () => {
    const refund = Refund.create('refund-1', { ...base, amount: Money.of(1_000, 'ETB') });
    refund.complete(new Date(), 'gw-refund-1');

    expect(refund.status).toBe(RefundStatus.COMPLETED);
    expect(refund.completedAt).toBeInstanceOf(Date);
    expect(refund.providerRef).toBe('gw-refund-1');
  });

  it('leaves completedAt null on failure — nothing completed', () => {
    const refund = Refund.create('refund-1', { ...base, amount: Money.of(1_000, 'ETB') });
    refund.fail('gw-refund-1');

    expect(refund.status).toBe(RefundStatus.FAILED);
    expect(refund.completedAt).toBeNull();
  });

  it.each([0, -1])('refuses to be created with a %s amount', (amount) => {
    expect(
      codeOf(() => Refund.create('refund-1', { ...base, amount: Money.of(amount, 'ETB') })),
    ).toBe(ErrorCode.VALIDATION_ERROR);
  });

  it('records no approver unless one is supplied', () => {
    expect(
      Refund.create('refund-1', { ...base, amount: Money.of(1_000, 'ETB') }).approvedBy,
    ).toBeNull();
    expect(
      Refund.create('refund-2', {
        ...base,
        idempotencyKey: 'refund-key-2',
        amount: Money.of(1_000, 'ETB'),
        approvedBy: 'finance-1',
      }).approvedBy,
    ).toBe('finance-1');
  });

  it('carries no card data — the persisted shape is exactly §7\'s refunds columns', () => {
    const props = Refund.create('refund-1', { ...base, amount: Money.of(1_000, 'ETB') }).toProps();

    expect(Object.keys(props).sort()).toEqual(
      [
        'amount',
        'approvedBy',
        'completedAt',
        'createdAt',
        'destination',
        'id',
        'idempotencyKey',
        'paymentId',
        'providerRef',
        'reason',
        'status',
        'type',
      ].sort(),
    );
    for (const forbidden of ['pan', 'cardNumber', 'cvv', 'expiry', 'holderName']) {
      expect(Object.keys(props)).not.toContain(forbidden);
    }
  });
});
