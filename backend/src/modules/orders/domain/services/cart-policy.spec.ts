import { CartPolicy } from './cart-policy';

describe('CartPolicy', () => {
  describe('assertUniqueProduct', () => {
    it('allows adding a product not already in the cart', () => {
      expect(() => CartPolicy.assertUniqueProduct(['product-1', 'product-2'], 'product-3')).not.toThrow();
    });

    it('allows the very first item in an empty cart', () => {
      expect(() => CartPolicy.assertUniqueProduct([], 'product-1')).not.toThrow();
    });

    it('rejects a duplicate product already in the cart', () => {
      expect(() => CartPolicy.assertUniqueProduct(['product-1', 'product-2'], 'product-1')).toThrow(
        expect.objectContaining({ code: 'VALIDATION_ERROR' }),
      );
    });
  });

  describe('assertNotEmpty', () => {
    it('allows a cart with at least one item', () => {
      expect(() => CartPolicy.assertNotEmpty([{ catalogProductId: 'product-1' }])).not.toThrow();
    });

    it('rejects an empty cart at checkout readiness', () => {
      expect(() => CartPolicy.assertNotEmpty([])).toThrow(
        expect.objectContaining({ code: 'VALIDATION_ERROR' }),
      );
    });
  });
});
