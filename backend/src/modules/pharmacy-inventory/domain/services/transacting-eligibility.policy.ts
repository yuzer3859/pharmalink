import { LicenseStatus, TransactingStatus } from '../enums';

export interface EligibilityInput {
  transactingStatus: TransactingStatus;
  licenseStatus: LicenseStatus;
  licenseExpiresAt: Date | null;
}

/**
 * BRULE-05/08 (module-04 §3.9, §4). Pure, framework-free. Eligible iff `transactingStatus =
 * ACTIVE` AND `licenseStatus = VALID` AND (`licenseExpiresAt` is null OR `licenseExpiresAt >
 * now`) — the boundary at `licenseExpiresAt === now` is NOT eligible (a license expiring at
 * exactly `now` is treated as already expired).
 *
 * This exact shape is designed to be reused verbatim by Module 09's `ProviderEligibilityPolicy`
 * (§3.9) — kept as an independent copy per ADR-002 discipline.
 */
export const TransactingEligibilityPolicy = {
  isEligible(pharmacy: EligibilityInput, now: Date = new Date()): boolean {
    if (pharmacy.transactingStatus !== TransactingStatus.ACTIVE) {
      return false;
    }
    if (pharmacy.licenseStatus !== LicenseStatus.VALID) {
      return false;
    }
    if (pharmacy.licenseExpiresAt !== null && pharmacy.licenseExpiresAt.getTime() <= now.getTime()) {
      return false;
    }
    return true;
  },
};
