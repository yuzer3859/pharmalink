import { PaymentErrors } from '../errors';

export const MIN_COUPON_CODE_LENGTH = 3;
export const MAX_COUPON_CODE_LENGTH = 32;

/** Letters, digits, hyphen and underscore. Deliberately narrow — see the class doc. */
const CODE_PATTERN = /^[A-Z0-9_-]+$/;

/**
 * `CouponCode` — the canonical form of a coupon's code.
 *
 * ## The normalization decision, recorded rather than assumed
 *
 * §7 gives `coupons.code` a `@unique` index and says nothing about case. Left undecided, `SAVE10`
 * and `save10` become two different coupons that a customer cannot tell apart, and a customer who
 * types their code in lower case is told it does not exist.
 *
 * **Decision: codes are trimmed, upper-cased, and stored in that canonical form.** So:
 *
 *  - comparison is effectively case-insensitive, because there is only ever one case in the
 *    database — the uniqueness is enforced by the existing `@unique` index on the canonical value,
 *    not by a second lower-cased column or a functional index;
 *  - `  save10  ` entered by a customer and `SAVE10` created by an admin are the same coupon;
 *  - creating `save10` when `SAVE10` exists is a duplicate, and is refused as one.
 *
 * Upper case rather than lower case because coupon codes are conventionally printed and spoken in
 * upper case, so the canonical form is the one a human would recognise in an admin list.
 *
 * The character set is restricted to `A-Z 0-9 - _`. A coupon code is read aloud, printed on
 * flyers and typed by hand; allowing whitespace, punctuation or non-ASCII would create codes that
 * are ambiguous to transcribe, and would let two visually identical codes (a Cyrillic `А` versus a
 * Latin `A`) coexist as different coupons.
 */
export class CouponCode {
  private constructor(readonly value: string) {}

  static of(raw: string): CouponCode {
    if (typeof raw !== 'string') {
      throw PaymentErrors.validation('code must be a string.', { field: 'code' });
    }
    const value = raw.trim().toUpperCase();
    if (value.length < MIN_COUPON_CODE_LENGTH || value.length > MAX_COUPON_CODE_LENGTH) {
      throw PaymentErrors.validation(
        `code must be between ${MIN_COUPON_CODE_LENGTH} and ${MAX_COUPON_CODE_LENGTH} characters.`,
        { field: 'code' },
      );
    }
    if (!CODE_PATTERN.test(value)) {
      throw PaymentErrors.validation(
        'code may contain only letters, digits, hyphens and underscores.',
        { field: 'code' },
      );
    }
    return new CouponCode(value);
  }

  /**
   * Normalizes without validating — for a *lookup*, where an unknown or malformed code should
   * resolve to "no such coupon" rather than to a different error than a merely wrong code. Telling
   * the two apart would let a client probe the code format.
   */
  static normalize(raw: string): string {
    return typeof raw === 'string' ? raw.trim().toUpperCase() : '';
  }

  equals(other: CouponCode): boolean {
    return this.value === other.value;
  }

  toString(): string {
    return this.value;
  }
}
