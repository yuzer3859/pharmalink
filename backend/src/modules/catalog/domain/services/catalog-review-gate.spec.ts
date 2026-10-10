import { Product } from '../entities/product.entity';
import { ProductStatus, ProductType, RxClassification } from '../enums';
import { ProductStatusPolicy } from './product-status-policy';

/**
 * The catalogue review gate (module-16 Work 30): a DRAFT product is published only through review,
 * `DRAFT -> PENDING_REVIEW -> ACTIVE`, and `ProductStatusPolicy` is the one place that decides it.
 */
describe('Catalogue review gate', () => {
  const all = Object.values(ProductStatus);
  const next = (from: ProductStatus) => all.filter((to) => ProductStatusPolicy.isLegalTransition(from, to));

  it('DRAFT has exactly one way out: PENDING_REVIEW; PENDING_REVIEW has exactly one: ACTIVE', () => {
    expect(next(ProductStatus.DRAFT)).toEqual([ProductStatus.PENDING_REVIEW]);
    expect(next(ProductStatus.PENDING_REVIEW)).toEqual([ProductStatus.ACTIVE]);
  });

  it('every route from DRAFT to ACTIVE passes through PENDING_REVIEW', () => {
    // Search the state machine with PENDING_REVIEW removed: ACTIVE must be unreachable from DRAFT.
    const seen = new Set<ProductStatus>([ProductStatus.DRAFT]);
    const queue = [ProductStatus.DRAFT];
    while (queue.length) {
      for (const to of next(queue.shift()!)) {
        if (to !== ProductStatus.PENDING_REVIEW && !seen.has(to)) {
          seen.add(to);
          queue.push(to);
        }
      }
    }
    expect(seen.has(ProductStatus.ACTIVE)).toBe(false);
  });

  it('the other legal transitions are unchanged', () => {
    expect(next(ProductStatus.ACTIVE)).toEqual([ProductStatus.DEPRECATED, ProductStatus.DELISTED]);
    expect(next(ProductStatus.DEPRECATED)).toEqual([ProductStatus.ACTIVE, ProductStatus.DELISTED]);
    expect(next(ProductStatus.DELISTED)).toEqual([ProductStatus.DRAFT]);
  });

  it('the entity enforces it: DRAFT -> ACTIVE throws and the product stays DRAFT', () => {
    const p = Product.create('p-1', { type: ProductType.MEDICINE, genericName: 'Amoxicillin', manufacturerId: 'm-1', rxClassification: RxClassification.OTC, nameEn: 'Amoxicillin' });
    expect(() => p.transitionStatus(ProductStatus.ACTIVE)).toThrow(expect.objectContaining({ code: 'INVALID_PRODUCT_STATUS_TRANSITION' }));
    expect(p.status).toBe(ProductStatus.DRAFT);
  });

  it('no other entity write changes the status: applyEdits ignores a smuggled status', () => {
    const p = Product.create('p-1', { type: ProductType.MEDICINE, genericName: 'Amoxicillin', manufacturerId: 'm-1', rxClassification: RxClassification.OTC, nameEn: 'Amoxicillin' });
    const changed = p.applyEdits({ nameEn: 'Renamed', status: ProductStatus.ACTIVE } as unknown as Parameters<Product['applyEdits']>[0]);
    expect(changed).not.toContain('status');
    expect(p.status).toBe(ProductStatus.DRAFT);
  });
});
