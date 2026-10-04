import { VerificationPolicy } from './verification-policy';

describe('VerificationPolicy', () => {
  const prescription = { customerUserId: 'customer-1' };

  it('allows a PHARMACIST-at-pharmacy reviewer who is not the uploading customer', () => {
    expect(VerificationPolicy.canReview('pharmacist-1', prescription, true)).toBe(true);
  });

  it('rejects self-review even if the reviewer also holds PHARMACIST at the pharmacy', () => {
    expect(VerificationPolicy.canReview('customer-1', prescription, true)).toBe(false);
  });

  it('rejects a reviewer who is not PHARMACIST at the verifying pharmacy (org-scoping)', () => {
    expect(VerificationPolicy.canReview('pharmacist-at-other-pharmacy', prescription, false)).toBe(
      false,
    );
  });

  it('rejects when both guards fail (self-review AND wrong org)', () => {
    expect(VerificationPolicy.canReview('customer-1', prescription, false)).toBe(false);
  });

  it('assertCanReview throws VERIFICATION_FORBIDDEN on self-review', () => {
    expect(() => VerificationPolicy.assertCanReview('customer-1', prescription, true)).toThrow();
  });

  it('assertCanReview throws VERIFICATION_FORBIDDEN on wrong-organization reviewer', () => {
    expect(() =>
      VerificationPolicy.assertCanReview('pharmacist-elsewhere', prescription, false),
    ).toThrow();
  });

  it('assertCanReview does not throw for a valid reviewer', () => {
    expect(() =>
      VerificationPolicy.assertCanReview('pharmacist-1', prescription, true),
    ).not.toThrow();
  });
});
