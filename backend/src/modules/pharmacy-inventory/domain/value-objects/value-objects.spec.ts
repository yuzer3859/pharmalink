import { Money } from './money.vo';
import { Quantity } from './quantity.vo';
import { ExpiryDate } from './expiry-date.vo';
import { OperatingHours } from './operating-hours.vo';

describe('Money', () => {
  it('accepts a positive integer minor-unit amount in ETB', () => {
    expect(Money.of(1000, 'ETB').amountMinor).toBe(1000);
  });

  it('rejects negative amounts', () => {
    expect(() => Money.of(-100)).toThrow();
  });

  it('rejects non-integer (float) amounts', () => {
    expect(() => Money.of(10.5)).toThrow();
  });

  it('rejects a non-ETB currency in Slice 1', () => {
    expect(() => Money.of(100, 'USD')).toThrow();
  });
});

describe('Quantity', () => {
  it('accepts non-negative integers', () => {
    expect(Quantity.of(0).value).toBe(0);
    expect(Quantity.of(5).value).toBe(5);
  });

  it('rejects negative values', () => {
    expect(() => Quantity.of(-1)).toThrow();
  });

  it('rejects NaN', () => {
    expect(() => Quantity.of(NaN)).toThrow();
  });
});

describe('ExpiryDate', () => {
  it('isExpired is true when the date is in the past', () => {
    const expiry = ExpiryDate.of(new Date('2020-01-01'));
    expect(expiry.isExpired(new Date('2026-01-01'))).toBe(true);
  });

  it('isExpired is false when the date is in the future', () => {
    const expiry = ExpiryDate.of(new Date('2030-01-01'));
    expect(expiry.isExpired(new Date('2026-01-01'))).toBe(false);
  });
});

describe('OperatingHours', () => {
  it('accepts a valid open/close pair', () => {
    expect(
      OperatingHours.of({ weekday: 1, openTime: '08:00', closeTime: '18:00', isClosed: false }).props
        .weekday,
    ).toBe(1);
  });

  it('rejects openTime >= closeTime when not closed', () => {
    expect(() =>
      OperatingHours.of({ weekday: 1, openTime: '18:00', closeTime: '08:00', isClosed: false }),
    ).toThrow();
  });

  it('allows a closed day with no hours', () => {
    expect(OperatingHours.of({ weekday: 0, isClosed: true }).props.isClosed).toBe(true);
  });

  it('rejects an out-of-range weekday', () => {
    expect(() => OperatingHours.of({ weekday: 7, isClosed: true })).toThrow();
  });
});
