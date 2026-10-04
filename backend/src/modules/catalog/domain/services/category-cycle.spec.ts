import { CategoryCycleGuard } from './category-cycle';

describe('CategoryCycleGuard', () => {
  it('allows a brand-new category (no id yet) under any non-oversized chain', () => {
    expect(() => CategoryCycleGuard.assertNoCycle(undefined, ['parent', 'grandparent'])).not.toThrow();
  });

  it('rejects reparenting a category under its own descendant (cycle)', () => {
    expect(() =>
      CategoryCycleGuard.assertNoCycle('cat-1', ['cat-2', 'cat-1', 'root']),
    ).toThrow(expect.objectContaining({ code: 'CATEGORY_CYCLE_DETECTED' }));
  });

  it('allows reparenting when the category is not in the proposed ancestor chain', () => {
    expect(() => CategoryCycleGuard.assertNoCycle('cat-1', ['cat-2', 'root'])).not.toThrow();
  });

  it('rejects a chain deeper than the max depth (abuse guard)', () => {
    const deepChain = Array.from({ length: 8 }, (_, i) => `cat-${i}`);
    expect(() => CategoryCycleGuard.assertNoCycle(undefined, deepChain)).toThrow(
      expect.objectContaining({ code: 'CATEGORY_CYCLE_DETECTED' }),
    );
  });
});
