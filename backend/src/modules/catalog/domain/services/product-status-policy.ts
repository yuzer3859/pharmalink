import { CatalogErrors } from '../errors';
import { ProductStatus } from '../enums';

/**
 * Pure state machine for `Product.status` (module-03 §3.6 invariant 6, resolved by Architect
 * review §14.3: `DELISTED -> DRAFT` is a legal recovery transition, but `DELISTED -> ACTIVE` is
 * never legal directly — reactivating a delisted product always requires a fresh review). The
 * catalogue-review gate: a draft is published only through review — `DRAFT -> PENDING_REVIEW`
 * (submission, module-16 Work 29) then `PENDING_REVIEW -> ACTIVE` (approval, Work 28). `DRAFT ->
 * ACTIVE` is not legal (Work 30), on any route: every product status change goes through
 * `Product.transitionStatus`, i.e. through this policy.
 */
const LEGAL_TRANSITIONS: Record<ProductStatus, ReadonlySet<ProductStatus>> = {
  [ProductStatus.DRAFT]: new Set([ProductStatus.PENDING_REVIEW]),
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
