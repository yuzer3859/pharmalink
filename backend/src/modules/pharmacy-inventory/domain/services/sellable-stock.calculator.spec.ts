import { SellableStockCalculator } from './sellable-stock.calculator';

const NOW = new Date('2026-01-01T00:00:00.000Z');
const FUTURE = new Date('2026-06-01T00:00:00.000Z');
const PAST = new Date('2025-06-01T00:00:00.000Z');

describe('SellableStockCalculator', () => {
  it('returns 0 for zero batches', () => {
    expect(SellableStockCalculator.computeSellable([], 0, NOW)).toBe(0);
  });

  it('returns 0 when all batches are expired', () => {
    const batches = [
      { quantity: 10, expiryDate: PAST },
      { quantity: 5, expiryDate: PAST },
    ];
    expect(SellableStockCalculator.computeSellable(batches, 0, NOW)).toBe(0);
  });

  it('sums only non-expired batches', () => {
    const batches = [
      { quantity: 10, expiryDate: FUTURE },
      { quantity: 5, expiryDate: PAST },
      { quantity: 7, expiryDate: FUTURE },
    ];
    expect(SellableStockCalculator.computeSellable(batches, 0, NOW)).toBe(17);
  });

  it('subtracts reserved from the non-expired total', () => {
    const batches = [{ quantity: 10, expiryDate: FUTURE }];
    expect(SellableStockCalculator.computeSellable(batches, 4, NOW)).toBe(6);
  });

  it('floors at 0 when reserved exceeds on-hand (defensive, never negative)', () => {
    const batches = [{ quantity: 5, expiryDate: FUTURE }];
    expect(SellableStockCalculator.computeSellable(batches, 20, NOW)).toBe(0);
  });

  it('treats a batch expiring exactly at now as expired (not sellable)', () => {
    const batches = [{ quantity: 5, expiryDate: NOW }];
    expect(SellableStockCalculator.computeSellable(batches, 0, NOW)).toBe(0);
  });
});
