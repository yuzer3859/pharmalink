import { ApiException } from '../../../../shared/errors/api-exception';
import { ErrorCode } from '../../../../shared/errors/error-codes';
import { PaymentStatus } from '../enums';
import { PaymentStatusPolicy } from './payment-status-policy';

/**
 * The design's §6 transition table, transcribed once. Every test below is derived from it, so
 * the suite is exhaustive over all 9 x 9 status pairs rather than spot-checking a few.
 */
const LEGAL: ReadonlyArray<[PaymentStatus, PaymentStatus]> = [
  [PaymentStatus.INITIATED, PaymentStatus.AUTHORIZED],
  [PaymentStatus.INITIATED, PaymentStatus.FAILED],
  [PaymentStatus.INITIATED, PaymentStatus.EXPIRED],
  [PaymentStatus.AUTHORIZED, PaymentStatus.CAPTURED],
  [PaymentStatus.AUTHORIZED, PaymentStatus.VOIDED],
  [PaymentStatus.AUTHORIZED, PaymentStatus.EXPIRED],
  [PaymentStatus.CAPTURED, PaymentStatus.SETTLED],
  [PaymentStatus.CAPTURED, PaymentStatus.REFUNDED],
  [PaymentStatus.CAPTURED, PaymentStatus.PARTIALLY_REFUNDED],
  // ADR-018: a further refund exhausts the remainder.
  [PaymentStatus.PARTIALLY_REFUNDED, PaymentStatus.REFUNDED],
];

const ALL = Object.values(PaymentStatus);

// `PARTIALLY_REFUNDED` is deliberately absent: ADR-018 gives it an outgoing edge to `REFUNDED`.
const TERMINAL = [
  PaymentStatus.SETTLED,
  PaymentStatus.FAILED,
  PaymentStatus.VOIDED,
  PaymentStatus.REFUNDED,
  PaymentStatus.EXPIRED,
];

function isLegal(from: PaymentStatus, to: PaymentStatus): boolean {
  return LEGAL.some(([f, t]) => f === from && t === to);
}

describe('PaymentStatusPolicy (§6)', () => {
  it.each(LEGAL)('allows %s -> %s', (from, to) => {
    expect(PaymentStatusPolicy.isLegalTransition(from, to)).toBe(true);
    expect(() => PaymentStatusPolicy.assertValidTransition(from, to)).not.toThrow();
  });

  const illegal = ALL.flatMap((from) =>
    ALL.filter((to) => !isLegal(from, to)).map((to) => [from, to] as const),
  );

  it.each(illegal)('rejects %s -> %s', (from, to) => {
    expect(PaymentStatusPolicy.isLegalTransition(from, to)).toBe(false);
    expect(() => PaymentStatusPolicy.assertValidTransition(from, to)).toThrow(ApiException);
    try {
      PaymentStatusPolicy.assertValidTransition(from, to);
    } catch (error) {
      expect((error as ApiException).code).toBe(ErrorCode.INVALID_PAYMENT_STATE_TRANSITION);
      expect((error as ApiException).details).toEqual({ from, to });
    }
  });

  it('never allows a status to transition to itself (no self-loop is defined in §6)', () => {
    for (const status of ALL) {
      expect(PaymentStatusPolicy.isLegalTransition(status, status)).toBe(false);
    }
  });

  it.each(TERMINAL)('%s is terminal', (status) => {
    expect(PaymentStatusPolicy.isTerminal(status)).toBe(true);
    expect(PaymentStatusPolicy.legalTransitionsFrom(status)).toEqual([]);
  });

  it.each([PaymentStatus.INITIATED, PaymentStatus.AUTHORIZED, PaymentStatus.CAPTURED])(
    '%s is not terminal',
    (status) => {
      expect(PaymentStatusPolicy.isTerminal(status)).toBe(false);
      expect(PaymentStatusPolicy.legalTransitionsFrom(status).length).toBeGreaterThan(0);
    },
  );

  it('models PARTIALLY_REFUNDED -> REFUNDED (ADR-018) and nothing else out of that state', () => {
    expect(
      PaymentStatusPolicy.isLegalTransition(
        PaymentStatus.PARTIALLY_REFUNDED,
        PaymentStatus.REFUNDED,
      ),
    ).toBe(true);
    expect(PaymentStatusPolicy.isTerminal(PaymentStatus.PARTIALLY_REFUNDED)).toBe(false);
    expect(PaymentStatusPolicy.legalTransitionsFrom(PaymentStatus.PARTIALLY_REFUNDED)).toEqual([
      PaymentStatus.REFUNDED,
    ]);
    // In particular the settlement edge is still NOT modelled — ADR-018 records it as an open
    // question for the settlement task rather than granting it here.
    expect(
      PaymentStatusPolicy.isLegalTransition(
        PaymentStatus.PARTIALLY_REFUNDED,
        PaymentStatus.SETTLED,
      ),
    ).toBe(false);
  });

  it('still does not model SETTLED -> REFUNDED (§6 defines no way back out of a payout)', () => {
    expect(
      PaymentStatusPolicy.isLegalTransition(PaymentStatus.SETTLED, PaymentStatus.REFUNDED),
    ).toBe(false);
  });

  it('covers every declared PaymentStatus value (the enum and the table cannot drift apart)', () => {
    for (const status of ALL) {
      expect(() => PaymentStatusPolicy.legalTransitionsFrom(status)).not.toThrow();
    }
    expect(ALL).toHaveLength(9);
  });
});
