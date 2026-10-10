import { ProductStatus } from '../enums';
import { ProductStatusPolicy } from './product-status-policy';

describe('ProductStatusPolicy', () => {
  it.each([
    [ProductStatus.DRAFT, ProductStatus.ACTIVE, false], // module-16 Work 30: only through review
    [ProductStatus.ACTIVE, ProductStatus.DEPRECATED, true],
    [ProductStatus.ACTIVE, ProductStatus.DELISTED, true],
    [ProductStatus.DEPRECATED, ProductStatus.ACTIVE, true],
    [ProductStatus.DEPRECATED, ProductStatus.DELISTED, true],
    [ProductStatus.DELISTED, ProductStatus.DRAFT, true], // §14.3 resolved recovery transition
    [ProductStatus.DELISTED, ProductStatus.ACTIVE, false], // never direct
    [ProductStatus.DRAFT, ProductStatus.DELISTED, false],
    [ProductStatus.DRAFT, ProductStatus.PENDING_REVIEW, true], // module-16 Work 29: submission for review
    [ProductStatus.ACTIVE, ProductStatus.PENDING_REVIEW, false],
    [ProductStatus.DELISTED, ProductStatus.PENDING_REVIEW, false],
    [ProductStatus.PENDING_REVIEW, ProductStatus.ACTIVE, true], // module-16 Work 28: review approval
    [ProductStatus.PENDING_REVIEW, ProductStatus.DELISTED, false],
    [ProductStatus.ACTIVE, ProductStatus.DRAFT, false],
  ])('%s -> %s is legal: %s', (from, to, expected) => {
    expect(ProductStatusPolicy.isLegalTransition(from, to)).toBe(expected);
  });

  it('throws INVALID_PRODUCT_STATUS_TRANSITION for an illegal transition', () => {
    expect(() =>
      ProductStatusPolicy.assertValidTransition(ProductStatus.DELISTED, ProductStatus.ACTIVE),
    ).toThrow(expect.objectContaining({ code: 'INVALID_PRODUCT_STATUS_TRANSITION' }));
  });

  it('does not throw for a legal transition', () => {
    expect(() =>
      ProductStatusPolicy.assertValidTransition(ProductStatus.DELISTED, ProductStatus.DRAFT),
    ).not.toThrow();
  });
});
