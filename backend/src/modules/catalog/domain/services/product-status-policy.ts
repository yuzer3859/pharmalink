import { CatalogErrors } from '../errors';
import { ProductStatus } from '../enums';

/**
 * Pure state machine for `Product.status` (module-03 §3.6 invariant 6, resolved by Architect
 * review §14.3: `DELISTED -> DRAFT` is a legal recovery transition, but `DELISTED -> ACTIVE` is
 * never legal directly — reactivating a delisted product always requires a fresh `DRAFT ->
 * ACTIVE` review). The catalogue-review workflow: `DRAFT -> PENDING_REVIEW` submits a draft for
 * review (module-16 Work 29) and `PENDING_REVIEW -> ACTIVE` approves it (Work 28). `DRAFT ->
 * ACTIVE` remains legal as before, on Module 03's generic status route.
 */
const LEGAL_TRANSITIONS: Record<ProductStatus, ReadonlySet<ProductStatus>> = {
  [ProductStatus.DRAFT]: new Set([ProductStatus.ACTIVE, ProductStatus.PENDING_REVIEW]),
  [ProductStatus.ACTIVE]: new Set([ProductStatus.DEPRECATED, ProductStatus.DELISTED]),
  [ProductStatus.DEPRECATED]: new Set([ProductStatus.ACTIVE, ProductStatus.DELISTED]),
  [ProductStatus.DELISTED]: new Set([ProductStatus.DRAFT]),
  [ProductStatus.PENDING_REVIEW]: new Set([ProductStatus.ACTIVE]),
};

export const ProductStatusPolicy = {
  isLegalTransition(from: ProductStatus, to: ProductStatus): boolean {
    return LEGAL_TRANSITIONS[from]?.has(to) ?? false;
  },

  assertValidTransition(from: ProductStatus, to: ProductStatus): void {
    if (!ProductStatusPolicy.isLegalTransition(from, to)) {
      throw CatalogErrors.invalidStatusTransition(from, to);
    }
  },
};
