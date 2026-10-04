import { TransactingEligibilityPolicy } from './transacting-eligibility.policy';
import { LicenseStatus, TransactingStatus } from '../enums';

const NOW = new Date('2026-01-01T00:00:00.000Z');

describe('TransactingEligibilityPolicy', () => {
  it('is eligible when active, valid, and unexpired (or no expiry)', () => {
    expect(
      TransactingEligibilityPolicy.isEligible(
        {
          transactingStatus: TransactingStatus.ACTIVE,
          licenseStatus: LicenseStatus.VALID,
          licenseExpiresAt: new Date('2026-02-01T00:00:00.000Z'),
        },
        NOW,
      ),
    ).toBe(true);

    expect(
      TransactingEligibilityPolicy.isEligible(
        {
          transactingStatus: TransactingStatus.ACTIVE,
          licenseStatus: LicenseStatus.VALID,
          licenseExpiresAt: null,
        },
        NOW,
      ),
    ).toBe(true);
  });

  it('is ineligible when transactingStatus is not ACTIVE', () => {
    expect(
      TransactingEligibilityPolicy.isEligible(
        {
          transactingStatus: TransactingStatus.SUSPENDED,
          licenseStatus: LicenseStatus.VALID,
          licenseExpiresAt: null,
        },
        NOW,
      ),
    ).toBe(false);
    expect(
      TransactingEligibilityPolicy.isEligible(
        {
          transactingStatus: TransactingStatus.PENDING,
          licenseStatus: LicenseStatus.VALID,
          licenseExpiresAt: null,
        },
        NOW,
      ),
    ).toBe(false);
  });

  it('is ineligible when licenseStatus is not VALID', () => {
    expect(
      TransactingEligibilityPolicy.isEligible(
        {
          transactingStatus: TransactingStatus.ACTIVE,
          licenseStatus: LicenseStatus.EXPIRED,
          licenseExpiresAt: null,
        },
        NOW,
      ),
    ).toBe(false);
    expect(
      TransactingEligibilityPolicy.isEligible(
        {
          transactingStatus: TransactingStatus.ACTIVE,
          licenseStatus: LicenseStatus.SUSPENDED,
          licenseExpiresAt: null,
        },
        NOW,
      ),
    ).toBe(false);
  });

  it('is ineligible when licenseExpiresAt is in the past', () => {
    expect(
      TransactingEligibilityPolicy.isEligible(
        {
          transactingStatus: TransactingStatus.ACTIVE,
          licenseStatus: LicenseStatus.VALID,
          licenseExpiresAt: new Date('2025-12-31T23:59:59.000Z'),
        },
        NOW,
      ),
    ).toBe(false);
  });

  it('boundary: licenseExpiresAt === now is treated as expired (not eligible)', () => {
    expect(
      TransactingEligibilityPolicy.isEligible(
        {
          transactingStatus: TransactingStatus.ACTIVE,
          licenseStatus: LicenseStatus.VALID,
          licenseExpiresAt: new Date(NOW.getTime()),
        },
        NOW,
      ),
    ).toBe(false);
  });

  it('boundary: licenseExpiresAt one millisecond after now is eligible', () => {
    expect(
      TransactingEligibilityPolicy.isEligible(
        {
          transactingStatus: TransactingStatus.ACTIVE,
          licenseStatus: LicenseStatus.VALID,
          licenseExpiresAt: new Date(NOW.getTime() + 1),
        },
        NOW,
      ),
    ).toBe(true);
  });
});
