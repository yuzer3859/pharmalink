import { PaymentErrors } from '../errors';

const MAX_SCOPE_IDS = 200;
const MAX_ID_LENGTH = 64;

/**
 * The three scope dimensions §7 names — "`scope` (jsonb: product/category/pharmacy)" — and no
 * others. F-CPN-01 names the same three. Nothing else is accepted: an unknown key is rejected
 * rather than ignored, so a typo in an admin payload cannot silently widen a coupon to the whole
 * platform.
 */
export interface CouponScopeProps {
  productIds?: string[];
  categoryIds?: string[];
  pharmacyIds?: string[];
}

const SCOPE_KEYS = ['productIds', 'categoryIds', 'pharmacyIds'] as const;

/**
 * `CouponScope` — which lines of a cart or order a coupon may discount.
 *
 * ## How the dimensions combine, decided and recorded
 *
 * §7 says only "jsonb: product/category/pharmacy". It does not say how two dimensions on one
 * coupon interact, and the two readings differ in real money: a coupon carrying both
 * `categoryIds` and `pharmacyIds` either discounts lines matching *both* (AND) or lines matching
 * *either* (OR), and the OR reading discounts strictly more.
 *
 * **Decision: AND across dimensions, OR within one.** A line is eligible when it satisfies every
 * dimension the coupon declares; within a dimension, matching any listed id is enough. So
 * `{categoryIds: [vitamins], pharmacyIds: [A]}` means "vitamins, at pharmacy A" — the narrower
 * reading. That direction is chosen deliberately: an over-narrow coupon discounts less than
 * intended and is visible immediately, while an over-wide one quietly gives away margin, and the
 * design gives no basis for preferring the wider reading.
 *
 * An absent dimension is not a filter. A scope of `null`, `{}` or an omitted column therefore
 * means platform-wide, which is what an admin creating a coupon with no scope plainly intends.
 */
export class CouponScope {
  private constructor(
    readonly productIds: readonly string[] | null,
    readonly categoryIds: readonly string[] | null,
    readonly pharmacyIds: readonly string[] | null,
  ) {}

  /** Platform-wide: every line is eligible. */
  static unrestricted(): CouponScope {
    return new CouponScope(null, null, null);
  }

  /**
   * Parses the persisted `coupons.scope` JSON. `null`/`{}` is unrestricted; an unknown key or a
   * malformed id list is rejected, never silently dropped.
   */
  static parse(raw: unknown): CouponScope {
    if (raw === null || raw === undefined) {
      return CouponScope.unrestricted();
    }
    if (typeof raw !== 'object' || Array.isArray(raw)) {
      throw PaymentErrors.validation('scope must be an object.', { field: 'scope' });
    }

    const source = raw as Record<string, unknown>;
    for (const key of Object.keys(source)) {
      if (!(SCOPE_KEYS as readonly string[]).includes(key)) {
        throw PaymentErrors.validation(
          `Unknown coupon scope dimension "${key}". Only product, category and pharmacy scopes exist.`,
          { field: 'scope', dimension: key },
        );
      }
    }

    return new CouponScope(
      readIds(source.productIds, 'scope.productIds'),
      readIds(source.categoryIds, 'scope.categoryIds'),
      readIds(source.pharmacyIds, 'scope.pharmacyIds'),
    );
  }

  get isUnrestricted(): boolean {
    return this.productIds === null && this.categoryIds === null && this.pharmacyIds === null;
  }

  /** True when this scope constrains by pharmacy — the dimension a cart cannot answer. */
  get requiresPharmacy(): boolean {
    return this.pharmacyIds !== null;
  }

  /**
   * Whether one line is eligible. `AND` across the declared dimensions, `OR` within each — see the
   * class doc.
   *
   * A line whose pharmacy is unknown (`null`) does **not** match a pharmacy-scoped coupon. Absent
   * information is never treated as a match: guessing in the customer's favour would discount a
   * line that may turn out to be dispensed by a pharmacy the coupon excludes. ADR-020 confirms this
   * is only reachable from the pre-checkout preview — in checkout, Module 05's matching has already
   * chosen the pharmacy before a coupon is scored.
   */
  matches(line: { productId: string; categoryIds: readonly string[]; pharmacyId: string | null }): boolean {
    if (this.productIds && !this.productIds.includes(line.productId)) {
      return false;
    }
    if (this.categoryIds && !line.categoryIds.some((id) => this.categoryIds!.includes(id))) {
      return false;
    }
    if (this.pharmacyIds && (line.pharmacyId === null || !this.pharmacyIds.includes(line.pharmacyId))) {
      return false;
    }
    return true;
  }

  /** The persisted form: `null` for unrestricted, so an unscoped coupon stores no JSON at all. */
  toJSON(): CouponScopeProps | null {
    if (this.isUnrestricted) {
      return null;
    }
    return {
      ...(this.productIds ? { productIds: [...this.productIds] } : {}),
      ...(this.categoryIds ? { categoryIds: [...this.categoryIds] } : {}),
      ...(this.pharmacyIds ? { pharmacyIds: [...this.pharmacyIds] } : {}),
    };
  }
}

function readIds(raw: unknown, field: string): string[] | null {
  if (raw === null || raw === undefined) {
    return null;
  }
  if (!Array.isArray(raw)) {
    throw PaymentErrors.validation(`${field} must be an array of ids.`, { field });
  }
  if (raw.length === 0) {
    // An empty list would make *every* line ineligible, which is a coupon that can never apply —
    // almost certainly a mistake, and indistinguishable from "unscoped" if silently dropped.
    throw PaymentErrors.validation(`${field} must not be empty.`, { field });
  }
  if (raw.length > MAX_SCOPE_IDS) {
    throw PaymentErrors.validation(`${field} may list at most ${MAX_SCOPE_IDS} ids.`, { field });
  }
  const ids = raw.map((value) => {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw PaymentErrors.validation(`${field} must contain non-empty string ids.`, { field });
    }
    if (value.length > MAX_ID_LENGTH) {
      throw PaymentErrors.validation(`${field} contains an id that is too long.`, { field });
    }
    return value.trim();
  });
  return [...new Set(ids)];
}
