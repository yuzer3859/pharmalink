import { RemainingDispensable } from './remaining-dispensable';
import { RejectionReason } from './rejection-reason';
import { ValidityPeriod } from './validity-period';
import { RankingWeights } from './ranking-weights';

describe('RemainingDispensable', () => {
  it('computes approvedQuantity - dispensedSum', () => {
    expect(RemainingDispensable.compute(10, 4).value).toBe(6);
  });

  it('floors at exactly 0 when fully dispensed', () => {
    expect(RemainingDispensable.compute(5, 5).value).toBe(0);
  });

  it('reports isExhausted() correctly at the boundary', () => {
    expect(RemainingDispensable.compute(5, 5).isExhausted()).toBe(true);
    expect(RemainingDispensable.compute(5, 4).isExhausted()).toBe(false);
  });

  it('covers() checks a requested quantity against the remaining amount', () => {
    const remaining = RemainingDispensable.compute(10, 4); // remaining = 6
    expect(remaining.covers(6)).toBe(true);
    expect(remaining.covers(7)).toBe(false);
  });

  it('throws (invariant violation) if dispensedSum exceeds approvedQuantity', () => {
    expect(() => RemainingDispensable.compute(5, 6)).toThrow();
  });

  it('rejects a negative approvedQuantity', () => {
    expect(() => RemainingDispensable.compute(-1, 0)).toThrow();
  });

  it('rejects a non-integer dispensedSum', () => {
    expect(() => RemainingDispensable.compute(10, 2.5)).toThrow();
  });
});

describe('RejectionReason', () => {
  it('accepts a valid, trimmed reason', () => {
    expect(RejectionReason.of('  illegible handwriting  ').value).toBe('illegible handwriting');
  });

  it('rejects an empty reason with REJECTION_REASON_REQUIRED', () => {
    expect(() => RejectionReason.of('')).toThrow();
  });

  it('rejects a whitespace-only reason with REJECTION_REASON_REQUIRED', () => {
    expect(() => RejectionReason.of('   ')).toThrow();
  });

  it('rejects a null/undefined reason with REJECTION_REASON_REQUIRED', () => {
    expect(() => RejectionReason.of(null)).toThrow();
    expect(() => RejectionReason.of(undefined)).toThrow();
  });

  it('rejects a reason shorter than the minimum length', () => {
    expect(() => RejectionReason.of('no')).toThrow();
  });

  it('rejects a reason longer than the maximum length', () => {
    expect(() => RejectionReason.of('x'.repeat(501))).toThrow();
  });

  it('accepts a reason at exactly the boundary lengths', () => {
    expect(RejectionReason.of('abc').value).toBe('abc');
    expect(RejectionReason.of('x'.repeat(500)).value.length).toBe(500);
  });
});

describe('ValidityPeriod', () => {
  it('accepts a period with no dates at all', () => {
    const period = ValidityPeriod.of({});
    expect(period.issueDate).toBeNull();
    expect(period.expiryDate).toBeNull();
  });

  it('accepts expiryDate on or after issueDate', () => {
    expect(() =>
      ValidityPeriod.of({ issueDate: new Date('2026-01-01'), expiryDate: new Date('2026-01-01') }),
    ).not.toThrow();
    expect(() =>
      ValidityPeriod.of({ issueDate: new Date('2026-01-01'), expiryDate: new Date('2026-06-01') }),
    ).not.toThrow();
  });

  it('rejects expiryDate before issueDate', () => {
    expect(() =>
      ValidityPeriod.of({ issueDate: new Date('2026-06-01'), expiryDate: new Date('2026-01-01') }),
    ).toThrow();
  });

  it('isExpired() is false when expiryDate is absent, regardless of asOf', () => {
    const period = ValidityPeriod.of({});
    expect(period.isExpired(new Date('2099-01-01'))).toBe(false);
  });

  it('isExpired() is true once asOf reaches expiryDate (inclusive boundary)', () => {
    const period = ValidityPeriod.of({ expiryDate: new Date('2026-06-01T00:00:00Z') });
    expect(period.isExpired(new Date('2026-06-01T00:00:00Z'))).toBe(true);
    expect(period.isExpired(new Date('2026-06-02T00:00:00Z'))).toBe(true);
  });

  it('isExpired() is false before expiryDate', () => {
    const period = ValidityPeriod.of({ expiryDate: new Date('2026-06-01T00:00:00Z') });
    expect(period.isExpired(new Date('2026-05-31T00:00:00Z'))).toBe(false);
  });
});

describe('RankingWeights', () => {
  it('accepts non-negative finite weights', () => {
    const weights = RankingWeights.of({ distanceWeight: 0.7, priceWeight: 0.3 });
    expect(weights.distanceWeight).toBe(0.7);
    expect(weights.priceWeight).toBe(0.3);
  });

  it('accepts a zero weight for one term', () => {
    expect(() => RankingWeights.of({ distanceWeight: 1, priceWeight: 0 })).not.toThrow();
  });

  it('rejects a negative distanceWeight', () => {
    expect(() => RankingWeights.of({ distanceWeight: -0.1, priceWeight: 0.5 })).toThrow();
  });

  it('rejects a negative priceWeight', () => {
    expect(() => RankingWeights.of({ distanceWeight: 0.5, priceWeight: -0.1 })).toThrow();
  });

  it('rejects a non-finite weight', () => {
    expect(() => RankingWeights.of({ distanceWeight: Infinity, priceWeight: 0.3 })).toThrow();
    expect(() => RankingWeights.of({ distanceWeight: NaN, priceWeight: 0.3 })).toThrow();
  });
});
