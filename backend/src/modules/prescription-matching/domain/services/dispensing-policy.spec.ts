import { DispensingPolicy } from './dispensing-policy';

describe('DispensingPolicy', () => {
  const now = new Date('2026-06-01T00:00:00Z');

  it('returns OK when the requested quantity is exactly the remaining amount (exact-remaining case)', () => {
    expect(
      DispensingPolicy.canDispense({ remainingDispensable: 5, expiryDate: null }, 5, now),
    ).toBe('OK');
  });

  it('returns OK when the requested quantity is under the remaining amount', () => {
    expect(
      DispensingPolicy.canDispense({ remainingDispensable: 5, expiryDate: null }, 3, now),
    ).toBe('OK');
  });

  it('returns EXHAUSTED when the requested quantity exceeds the remaining amount', () => {
    expect(
      DispensingPolicy.canDispense({ remainingDispensable: 5, expiryDate: null }, 6, now),
    ).toBe('EXHAUSTED');
  });

  it('returns EXHAUSTED when remaining is already 0', () => {
    expect(
      DispensingPolicy.canDispense({ remainingDispensable: 0, expiryDate: null }, 1, now),
    ).toBe('EXHAUSTED');
  });

  it('returns EXPIRED when the prescription expiry has passed, even with sufficient remaining', () => {
    expect(
      DispensingPolicy.canDispense(
        { remainingDispensable: 10, expiryDate: new Date('2026-01-01T00:00:00Z') },
        1,
        now,
      ),
    ).toBe('EXPIRED');
  });

  it('treats the boundary asOf === expiryDate as expired', () => {
    expect(
      DispensingPolicy.canDispense({ remainingDispensable: 10, expiryDate: now }, 1, now),
    ).toBe('EXPIRED');
  });

  it('EXPIRED takes precedence over EXHAUSTED when both would otherwise apply', () => {
    expect(
      DispensingPolicy.canDispense(
        { remainingDispensable: 0, expiryDate: new Date('2020-01-01T00:00:00Z') },
        1,
        now,
      ),
    ).toBe('EXPIRED');
  });

  it('treats a null expiryDate as "no stated expiry" — never EXPIRED', () => {
    expect(
      DispensingPolicy.canDispense({ remainingDispensable: 1, expiryDate: null }, 1, now),
    ).toBe('OK');
  });

  it('assertCanDispense throws PRESCRIPTION_EXPIRED for an expired line', () => {
    expect(() =>
      DispensingPolicy.assertCanDispense(
        { remainingDispensable: 10, expiryDate: new Date('2020-01-01T00:00:00Z') },
        1,
        now,
      ),
    ).toThrow();
  });

  it('assertCanDispense throws PRESCRIPTION_EXHAUSTED for an over-remaining request', () => {
    expect(() =>
      DispensingPolicy.assertCanDispense({ remainingDispensable: 2, expiryDate: null }, 3, now),
    ).toThrow();
  });

  it('assertCanDispense does not throw for a valid dispense', () => {
    expect(() =>
      DispensingPolicy.assertCanDispense({ remainingDispensable: 5, expiryDate: null }, 5, now),
    ).not.toThrow();
  });
});
