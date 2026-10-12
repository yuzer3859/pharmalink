import { CatalogErrors } from '../errors';
import { ProductStatus } from '../enums';

/**
 * Pure state machine for `Product.status` (module-03 §3.6 invariant 6, resolved by Architect
 * review §14.3: `DELISTED -> DRAFT` is a legal recovery transition, but `DELISTED -> ACTIVE` is
 * never legal directly — reactivating a delisted product always requires a fresh review). The
 * catalogue-review gate: a draft is published only through review — `DRAFT -> PENDING_REVIEW`
 * (submission, module-16 Work 29) then `PENDING_REVIEW -> ACTIVE` (approval, Work 28). `DRAFT ->
 * ACTIVE` is not legal (Work 30), on any route: every product status change goes through
 * `Product.transitionStatus`, i.e. through this policy. A product under review can instead be
 * rejected (Work 31): `PENDING_REVIEW -> REJECTED`, which requires a reason. A rejected product,
 * once corrected, can be resubmitted (Work 32): `REJECTED -> PENDING_REVIEW` — back under review, never
 * straight to `ACTIVE`.
 */
const LEGAL_TRANSITIONS: Record<ProductStatus, ReadonlySet<ProductStatus>> = {
  [ProductStatus.DRAFT]: new Set([ProductStatus.PENDING_REVIEW]),
  [ProductStatus.ACTIVE]: new Set([ProductStatus.DEPRECATED, ProductStatus.DELISTED]),
  [ProductStatus.DEPRECATED]: new Set([ProductStatus.ACTIVE, ProductStatus.DELISTED]),
  [ProductStatus.DELISTED]: new Set([ProductStatus.DRAFT]),
  [ProductStatus.PENDING_REVIEW]: new Set([ProductStatus.ACTIVE, ProductStatus.REJECTED]),
  [ProductStatus.REJECTED]: new Set([ProductStatus.PENDING_REVIEW]),
};

/** A rejection reason, trimmed: at least 3 characters (the admin rejection convention), at most 300 (Module 03's status-reason limit). */
export const REJECTION_REASON_MIN_LENGTH = 3;
export const REJECTION_REASON_MAX_LENGTH = 300;

export const ProductStatusPolicy = {
  isLegalTransition(from: ProductStatus, to: ProductStatus): boolean {
    return LEGAL_TRANSITIONS[from]?.has(to) ?? false;
  },

  assertValidTransition(from: ProductStatus, to: ProductStatus): void {
    if (!ProductStatusPolicy.isLegalTransition(from, to)) {
      throw CatalogErrors.invalidStatusTransition(from, to);
    }
  },

  /**
   * The reason to record for a change to `to`. A rejection (module-16 Work 31) must give one:
   * trimmed, `REJECTION_REASON_MIN_LENGTH`..`REJECTION_REASON_MAX_LENGTH` characters, else
   * `VALIDATION_ERROR` — enforced here, for every path that can reject, not only a controller.
   * Any other change keeps its optional reason exactly as given.
   */
  reasonFor(to: ProductStatus, reason: string | null | undefined): string | null {
    if (to !== ProductStatus.REJECTED) {
      return reason ?? null;
    }
    const trimmed = typeof reason === 'string' ? reason.trim() : '';
    if (trimmed.length < REJECTION_REASON_MIN_LENGTH || trimmed.length > REJECTION_REASON_MAX_LENGTH) {
      throw CatalogErrors.validation(
        `A rejection reason of ${REJECTION_REASON_MIN_LENGTH}-${REJECTION_REASON_MAX_LENGTH} characters is required.`,
        { field: 'reason' },
      );
    }
    return trimmed;
  },
};
