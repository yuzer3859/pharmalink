import { PricingCalculator } from './pricing-calculator';

describe('PricingCalculator', () => {
  describe('computeTotals — normal totals', () => {
    it('computes a single-line order with no fees/discount', () => {
      const result = PricingCalculator.computeTotals({
        lines: [{ unitPrice: 100, quantity: 2 }],
        deliveryFee: 0,
        platformFeePercent: 0,
      });

      expect(result.lines).toEqual([{ unitPrice: 100, quantity: 2, lineTotal: 200 }]);
      expect(result.subtotal).toBe(200);
      expect(result.deliveryFee).toBe(0);
      expect(result.platformFee).toBe(0);
      expect(result.discountTotal).toBe(0);
      expect(result.grandTotal).toBe(200);
      expect(result.currency).toBe('ETB');
    });

    it('sums multiple order lines correctly', () => {
      const result = PricingCalculator.computeTotals({
        lines: [
          { unitPrice: 100, quantity: 2 },
          { unitPrice: 50, quantity: 3 },
          { unitPrice: 10, quantity: 1 },
        ],
        deliveryFee: 30,
        platformFeePercent: 0,
      });

      // 200 + 150 + 10 = 360
      expect(result.subtotal).toBe(360);
      expect(result.grandTotal).toBe(390);
    });

    it('includes delivery fee and platform fee in the grand total', () => {
      const result = PricingCalculator.computeTotals({
        lines: [{ unitPrice: 1000, quantity: 1 }],
        deliveryFee: 50,
        platformFeePercent: 0.1,
      });

      expect(result.subtotal).toBe(1000);
      expect(result.platformFee).toBe(100); // 1000 * 0.1
      expect(result.grandTotal).toBe(1150); // 1000 + 50 + 100
    });

    it('subtracts discountTotal from the grand total', () => {
      const result = PricingCalculator.computeTotals({
        lines: [{ unitPrice: 500, quantity: 1 }],
        deliveryFee: 0,
        platformFeePercent: 0,
        discountTotal: 100,
      });

      expect(result.grandTotal).toBe(400);
    });

    it('never returns a negative grand total even if discount exceeds subtotal', () => {
      const result = PricingCalculator.computeTotals({
        lines: [{ unitPrice: 50, quantity: 1 }],
        deliveryFee: 0,
        platformFeePercent: 0,
        discountTotal: 1000,
      });

      expect(result.grandTotal).toBe(0);
    });
  });

  describe('quantity multiplication', () => {
    it('multiplies unitPrice by quantity for the line total', () => {
      const result = PricingCalculator.computeTotals({
        lines: [{ unitPrice: 333, quantity: 7 }],
        deliveryFee: 0,
        platformFeePercent: 0,
      });
      expect(result.lines[0].lineTotal).toBe(2331);
    });
  });

  describe('rounding/precision rules', () => {
    it('rounds a fractional platform fee to the nearest minor unit', () => {
      const result = PricingCalculator.computeTotals({
        lines: [{ unitPrice: 333, quantity: 1 }],
        deliveryFee: 0,
        platformFeePercent: 0.1, // 33.3 -> 33
      });
      expect(result.platformFee).toBe(33);
    });

    it('rounds up when the fractional part is >= 0.5', () => {
      const result = PricingCalculator.computeTotals({
        lines: [{ unitPrice: 335, quantity: 1 }],
        deliveryFee: 0,
        platformFeePercent: 0.1, // 33.5 -> 34 (Math.round)
      });
      expect(result.platformFee).toBe(34);
    });
  });

  describe('zero/invalid quantities and prices', () => {
    it('rejects a zero-quantity line', () => {
      expect(() =>
        PricingCalculator.computeTotals({
          lines: [{ unitPrice: 100, quantity: 0 }],
          deliveryFee: 0,
          platformFeePercent: 0,
        }),
      ).toThrow(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
    });

    it('rejects a negative-quantity line', () => {
      expect(() =>
        PricingCalculator.computeTotals({
          lines: [{ unitPrice: 100, quantity: -1 }],
          deliveryFee: 0,
          platformFeePercent: 0,
        }),
      ).toThrow(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
    });

    it('rejects a negative unitPrice', () => {
      expect(() =>
        PricingCalculator.computeTotals({
          lines: [{ unitPrice: -5, quantity: 1 }],
          deliveryFee: 0,
          platformFeePercent: 0,
        }),
      ).toThrow(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
    });

    it('rejects a negative deliveryFee', () => {
      expect(() =>
        PricingCalculator.computeTotals({
          lines: [{ unitPrice: 100, quantity: 1 }],
          deliveryFee: -1,
          platformFeePercent: 0,
        }),
      ).toThrow(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
    });

    it('rejects a platformFeePercent outside [0, 1]', () => {
      expect(() =>
        PricingCalculator.computeTotals({
          lines: [{ unitPrice: 100, quantity: 1 }],
          deliveryFee: 0,
          platformFeePercent: 1.5,
        }),
      ).toThrow(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
    });

    it('handles an empty lines array as a valid zero-subtotal computation (checkout readiness is CartPolicy\'s job, not this function\'s)', () => {
      const result = PricingCalculator.computeTotals({
        lines: [],
        deliveryFee: 20,
        platformFeePercent: 0,
      });
      expect(result.subtotal).toBe(0);
      expect(result.grandTotal).toBe(20);
    });
  });

  describe('currency behavior', () => {
    it('defaults to ETB when no currency is supplied', () => {
      const result = PricingCalculator.computeTotals({
        lines: [{ unitPrice: 100, quantity: 1 }],
        deliveryFee: 0,
        platformFeePercent: 0,
      });
      expect(result.currency).toBe('ETB');
    });

    it('accepts an explicit ETB currency', () => {
      const result = PricingCalculator.computeTotals({
        lines: [{ unitPrice: 100, quantity: 1 }],
        deliveryFee: 0,
        platformFeePercent: 0,
        currency: 'ETB',
      });
      expect(result.currency).toBe('ETB');
    });

    it('rejects an unsupported currency (no multi-currency support in Slice 1, ADR-005)', () => {
      expect(() =>
        PricingCalculator.computeTotals({
          lines: [{ unitPrice: 100, quantity: 1 }],
          deliveryFee: 0,
          platformFeePercent: 0,
          currency: 'USD',
        }),
      ).toThrow(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
    });
  });
});
