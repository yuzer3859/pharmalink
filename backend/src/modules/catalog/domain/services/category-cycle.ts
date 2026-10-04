import { CatalogErrors } from '../errors';
import { MAX_CATEGORY_DEPTH } from '../enums';

/**
 * Pure predicate for the category cycle/abuse-depth guard (module-03 §3.6 invariant 5). The
 * repository walks the proposed parent's ancestor chain (root-first is not required — any order
 * works, this only checks membership + length); this function decides whether that chain is
 * acceptable for `categoryId` to adopt as its new parent chain.
 *
 * @param categoryId the category being created/reparented (`undefined` for a brand-new category
 *   that has no id yet, since it cannot possibly already be its own ancestor).
 * @param parentChain the proposed parent's own ancestor chain, INCLUDING the proposed parent
 *   itself, ordered from the proposed parent up to the root.
 */
export const CategoryCycleGuard = {
  assertNoCycle(categoryId: string | undefined, parentChain: readonly string[]): void {
    if (parentChain.length > MAX_CATEGORY_DEPTH) {
      throw CatalogErrors.categoryCycleDetected();
    }
    if (categoryId && parentChain.includes(categoryId)) {
      throw CatalogErrors.categoryCycleDetected();
    }
  },
};
