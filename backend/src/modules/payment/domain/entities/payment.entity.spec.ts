import { readFileSync } from 'fs';
import { join } from 'path';
import { ApiException } from '../../../../shared/errors/api-exception';
import { ErrorCode } from '../../../../shared/errors/error-codes';
import { PaymentMethod, PaymentStatus } from '../enums';
import { FxRate } from '../value-objects/fx-rate.vo';
import { IdempotencyKey } from '../value-objects/idempotency-key.vo';
import { MAX_PERSISTABLE_MINOR_UNITS, Money } from '../value-objects/money.vo';
import { Payment } from './payment.entity';

const NOW = new Date('2026-09-08T09:00:00.000Z');

function expectApiError(fn: () => unknown, code: ErrorCode): void {
  expect(fn).toThrow(ApiException);
  try {
    fn();
  } catch (error) {
    expect((error as ApiException).code).toBe(code);
  }
}

function initiate(overrides: Partial<Parameters<typeof Payment.initiate>[1]> = {}): Payment {
  return Payment.initiate(
    'payment-1',
    {
      orderId: 'order-1',
      customerUserId: 'customer-1',
      method: PaymentMethod.TELEBIRR,
      amount: Money.base(10_000),
      idempotencyKey: 'pay-order-1-attempt-1',
      ...overrides,
    },
    NOW,
  );
}

describe('Payment.initiate (§5.1, §6 entry state)', () => {
  it('opens a payment in INITIATED with no authorization or capture timestamp', () => {
    const payment = initiate();
    const props = payment.toProps();

    expect(payment.status).toBe(PaymentStatus.INITIATED);
    expect(payment.amount.amountMinor).toBe(10_000);
    expect(payment.amount.currency.code).toBe('ETB');
    expect(props.authorizedAt).toBeNull();
    expect(props.capturedAt).toBeNull();
    expect(props.failureReason).toBeNull();
    expect(props.providerRef).toBeNull();
    expect(props.createdAt).toEqual(NOW);
    expect(payment.isTerminal).toBe(false);
  });

  it('accepts an IdempotencyKey value object as well as a raw string, and validates it', () => {
    expect(initiate({ idempotencyKey: IdempotencyKey.of('pay-vo-key-1') }).idempotencyKey).toBe(
      'pay-vo-key-1',
    );
    expectApiError(() => initiate({ idempotencyKey: 'short' }), ErrorCode.VALIDATION_ERROR);
    expectApiError(() => initiate({ idempotencyKey: 'has spaces here' }), ErrorCode.VALIDATION_ERROR);
  });

  it.each([0, -1])('rejects the non-positive amount %p', (amount) => {
    expectApiError(() => initiate({ amount: Money.base(amount) }), ErrorCode.VALIDATION_ERROR);
  });

  it('rejects a fractional amount and an amount that cannot be persisted', () => {
    expectApiError(() => Money.base(10.5), ErrorCode.VALIDATION_ERROR);
    expectApiError(
      () => initiate({ amount: Money.base(MAX_PERSISTABLE_MINOR_UNITS + 1) }),
      ErrorCode.VALIDATION_ERROR,
    );
  });

  it('rejects a non-ETB amount: every payment is recorded in ETB (BRULE-22)', () => {
    expectApiError(
      () => initiate({ amount: Money.of(10_000, 'USD') }),
      ErrorCode.VALIDATION_ERROR,
    );
  });

  it('requires exactly one of amount (domestic) or fx (cross-border)', () => {
    expectApiError(() => initiate({ amount: undefined }), ErrorCode.VALIDATION_ERROR);
    expectApiError(
      () =>
        initiate({
          amount: Money.base(10_000),
          fx: {
            originalAmount: Money.of(1000, 'USD'),
            rate: FxRate.of({ rate: 57.5, source: 'nbe', capturedAt: NOW }),
          },
        }),
      ErrorCode.VALIDATION_ERROR,
    );
  });

  it.each([
    ['', 'orderId'],
    ['   ', 'customerUserId'],
  ])('rejects a blank required reference (%p)', (value, field) => {
    expectApiError(() => initiate({ [field]: value }), ErrorCode.VALIDATION_ERROR);
  });

  it('rejects an unknown payment method', () => {
    expectApiError(
      () => initiate({ method: 'BITCOIN' as PaymentMethod }),
      ErrorCode.VALIDATION_ERROR,
    );
  });
});

describe('Payment.initiate — cross-border FX (§8)', () => {
  const rate = FxRate.of({ rate: 57.5, source: 'nbe-daily', capturedAt: NOW });

  it('derives the ETB amount from the captured rate and records the original alongside it', () => {
    const payment = initiate({
      amount: undefined,
      method: PaymentMethod.CROSS_BORDER,
      fx: { originalAmount: Money.of(1000, 'USD'), rate },
    });
    const props = payment.toProps();

    expect(payment.amount.amountMinor).toBe(57_500);
    expect(payment.amount.currency.code).toBe('ETB');
    expect(props.originalAmount).toBe(1000);
    expect(props.originalCurrency).toBe('USD');
    expect(props.fxRate).toBe(57.5);
    expect(props.fxSource).toBe('nbe-daily');
    expect(payment.originalAmount?.amountMinor).toBe(1000);
  });

  it('rejects a non-positive original amount', () => {
    expectApiError(
      () =>
        initiate({
          amount: undefined,
          fx: { originalAmount: Money.of(0, 'USD'), rate },
        }),
      ErrorCode.VALIDATION_ERROR,
    );
  });

  it('leaves every FX field null for a domestic payment (the DB CHECK requires all or none)', () => {
    const props = initiate().toProps();
    expect(props.originalAmount).toBeNull();
    expect(props.originalCurrency).toBeNull();
    expect(props.fxRate).toBeNull();
    expect(props.fxSource).toBeNull();
    expect(props.originalAmount).toBeNull();
    expect(initiate().originalAmount).toBeNull();
  });
});

describe('Payment — legal transitions (§6)', () => {
  const later = new Date('2026-09-08T10:00:00.000Z');

  it('INITIATED -> AUTHORIZED stamps authorizedAt and the provider reference', () => {
    const payment = initiate();
    payment.authorize(later, 'telebirr-ref-1');

    expect(payment.status).toBe(PaymentStatus.AUTHORIZED);
    expect(payment.authorizedAt).toEqual(later);
    expect(payment.providerRef).toBe('telebirr-ref-1');
    expect(payment.toProps().updatedAt).toEqual(later);
  });

  it('AUTHORIZED -> CAPTURED stamps capturedAt and keeps authorizedAt', () => {
    const payment = initiate();
    payment.authorize(NOW);
    payment.capture(later);

    expect(payment.status).toBe(PaymentStatus.CAPTURED);
    expect(payment.authorizedAt).toEqual(NOW);
    expect(payment.capturedAt).toEqual(later);
  });

  it('CAPTURED -> SETTLED', () => {
    const payment = initiate();
    payment.authorize(NOW);
    payment.capture(NOW);
    payment.settle(later);
    expect(payment.status).toBe(PaymentStatus.SETTLED);
    expect(payment.isTerminal).toBe(true);
  });

  it('INITIATED -> FAILED records the reason', () => {
    const payment = initiate();
    payment.fail('Insufficient funds at provider', later);
    expect(payment.status).toBe(PaymentStatus.FAILED);
    expect(payment.failureReason).toBe('Insufficient funds at provider');
  });

  it('AUTHORIZED -> VOIDED releases the hold without charging', () => {
    const payment = initiate();
    payment.authorize(NOW);
    payment.voidAuthorization(later);
    expect(payment.status).toBe(PaymentStatus.VOIDED);
    expect(payment.capturedAt).toBeNull();
  });

  it.each([
    ['INITIATED', (p: Payment) => p.expire()],
    ['AUTHORIZED', (p: Payment) => {
      p.authorize(NOW);
      p.expire();
    }],
  ])('%s -> EXPIRED', (_from, act) => {
    const payment = initiate();
    act(payment);
    expect(payment.status).toBe(PaymentStatus.EXPIRED);
  });

  it.each([
    ['REFUNDED', (p: Payment) => p.markRefunded(), PaymentStatus.REFUNDED],
    [
      'PARTIALLY_REFUNDED',
      (p: Payment) => p.markPartiallyRefunded(),
      PaymentStatus.PARTIALLY_REFUNDED,
    ],
  ])('CAPTURED -> %s (BRULE-24)', (_name, act, expected) => {
    const payment = initiate();
    payment.authorize(NOW);
    payment.capture(NOW);
    act(payment);
    expect(payment.status).toBe(expected);
  });

  it('PARTIALLY_REFUNDED -> REFUNDED once the remainder is exhausted (ADR-018)', () => {
    const payment = initiate();
    payment.authorize(NOW);
    payment.capture(NOW);
    payment.markPartiallyRefunded();

    payment.markRefunded();

    expect(payment.status).toBe(PaymentStatus.REFUNDED);
    // And REFUNDED stays terminal — the edge is one-way.
    expect(payment.isTerminal).toBe(true);
  });
});

describe('Payment — illegal transitions (§6)', () => {
  function expectRejected(act: () => void): void {
    expect(act).toThrow(ApiException);
    try {
      act();
    } catch (error) {
      expect((error as ApiException).code).toBe(ErrorCode.INVALID_PAYMENT_STATE_TRANSITION);
    }
  }

  it('cannot capture a payment that was never authorized', () => {
    const payment = initiate();
    expectRejected(() => payment.capture());
    expect(payment.status).toBe(PaymentStatus.INITIATED);
    expect(payment.capturedAt).toBeNull();
  });

  it('cannot settle, refund or void from INITIATED', () => {
    expectRejected(() => initiate().settle());
    expectRejected(() => initiate().markRefunded());
    expectRejected(() => initiate().voidAuthorization());
  });

  it('cannot void an already-captured payment (money has moved — that is a refund)', () => {
    const payment = initiate();
    payment.authorize(NOW);
    payment.capture(NOW);
    expectRejected(() => payment.voidAuthorization());
    expect(payment.status).toBe(PaymentStatus.CAPTURED);
  });

  it('cannot re-authorize or re-capture (no self-loop)', () => {
    const payment = initiate();
    payment.authorize(NOW);
    expectRejected(() => payment.authorize());
    payment.capture(NOW);
    expectRejected(() => payment.capture());
  });

  it.each([
    ['FAILED', (p: Payment) => p.fail('gateway timeout')],
    ['VOIDED', (p: Payment) => {
      p.authorize(NOW);
      p.voidAuthorization();
    }],
    ['EXPIRED', (p: Payment) => p.expire()],
  ])('a %s payment is terminal — no further transition is accepted', (_name, act) => {
    const payment = initiate();
    act(payment);
    expect(payment.isTerminal).toBe(true);
    expectRejected(() => payment.authorize());
    expectRejected(() => payment.capture());
    expectRejected(() => payment.settle());
    expectRejected(() => payment.markRefunded());
  });

  it('a SETTLED payment cannot be refunded (§6 defines no such transition)', () => {
    const payment = initiate();
    payment.authorize(NOW);
    payment.capture(NOW);
    payment.settle();
    expectRejected(() => payment.markRefunded());
  });

  it('rejects an empty failure reason without changing state', () => {
    const payment = initiate();
    expectApiError(() => payment.fail('   '), ErrorCode.VALIDATION_ERROR);
    expect(payment.status).toBe(PaymentStatus.INITIATED);
  });
});

describe('Payment — rehydration and encapsulation', () => {
  it('rehydrates a persisted row and continues its lifecycle', () => {
    const props = initiate().toProps();
    const rehydrated = Payment.rehydrate({ ...props, status: PaymentStatus.AUTHORIZED });
    rehydrated.capture(NOW);
    expect(rehydrated.status).toBe(PaymentStatus.CAPTURED);
  });

  it('toProps returns a copy — mutating it cannot corrupt the aggregate', () => {
    const payment = initiate();
    const props = payment.toProps();
    props.status = PaymentStatus.CAPTURED;
    props.amount = 999_999;
    expect(payment.status).toBe(PaymentStatus.INITIATED);
    expect(payment.amount.amountMinor).toBe(10_000);
  });
});

describe('PCI boundary (BRULE-26, NFR-SEC-04)', () => {
  it('exposes no raw card field on the aggregate — only provider-issued references', () => {
    const props = initiate({ providerToken: 'tok_gateway_opaque_1', provider: 'telebirr' })
      .toProps();
    const fields = Object.keys(props).map((key) => key.toLowerCase());

    for (const forbidden of ['pan', 'cardnumber', 'card', 'cvv', 'cvc', 'expiry', 'cardholder']) {
      expect(fields).not.toContain(forbidden);
    }
    expect(props.providerToken).toBe('tok_gateway_opaque_1');
    expect(props.provider).toBe('telebirr');
  });

  it('the payments Prisma model declares no card-data column', () => {
    const schema = readFileSync(
      join(__dirname, '../../../../../prisma/schema/07-payment.prisma'),
      'utf8',
    );
    const model = schema.slice(schema.indexOf('model Payment {'));
    const body = model.slice(0, model.indexOf('\n}')).toLowerCase();

    for (const forbidden of ['pan ', 'cardnumber', 'cvv', 'cvc', 'cardholder']) {
      expect(body).not.toContain(forbidden);
    }
  });
});
