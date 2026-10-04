/**
 * Domain enums for the Profiles bounded context. Framework-free and mirror the string values of
 * the Prisma enums (backend/prisma/schema/02-profiles.prisma) so repository adapters can map 1:1
 * without a translation table, while the domain stays free of any Prisma import (module-02 §12,
 * mirroring the Dependency Rule already applied in module-01 §12).
 */

export enum Gender {
  MALE = 'MALE',
  FEMALE = 'FEMALE',
  OTHER = 'OTHER',
  UNKNOWN = 'UNKNOWN',
}

export enum AddressLabel {
  HOME = 'HOME',
  WORK = 'WORK',
  OTHER = 'OTHER',
}

/**
 * This slice supports exactly one IANA timezone (module-02 §4.1) — validating arbitrary IANA
 * strings would pull in a tz database dependency for zero current business value.
 */
export const IANA_TZ_ALLOWLIST: readonly string[] = ['Africa/Addis_Ababa'];

/** Abuse/DoS guard on saved addresses per user (module-02 §3.2 invariant 1). */
export const MAX_ADDRESSES_PER_USER = 20;
