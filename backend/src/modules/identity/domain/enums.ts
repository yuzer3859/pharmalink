/**
 * Domain enums for the Identity bounded context. These are framework-free and deliberately
 * mirror the string values of the Prisma enums (backend/prisma/schema/01-identity.prisma) so
 * repository adapters can map 1:1 without a translation table, while the domain stays free of
 * any Prisma import (Dependency Rule — see module-01 §12).
 */

export enum AccountStatus {
  PENDING_VERIFICATION = 'PENDING_VERIFICATION',
  ACTIVE = 'ACTIVE',
  SUSPENDED = 'SUSPENDED',
  DEACTIVATED = 'DEACTIVATED',
  DELETED = 'DELETED',
  PENDING_APPROVAL = 'PENDING_APPROVAL',
  REJECTED = 'REJECTED',
}

export enum PrimaryRole {
  CUSTOMER = 'CUSTOMER',
  PHARMACY_OWNER = 'PHARMACY_OWNER',
  PHARMACY_MANAGER = 'PHARMACY_MANAGER',
  PHARMACIST = 'PHARMACIST',
  CASHIER = 'CASHIER',
  INVENTORY_STAFF = 'INVENTORY_STAFF',
  DOCTOR = 'DOCTOR',
  DRIVER = 'DRIVER',
  HOSPITAL_ADMIN = 'HOSPITAL_ADMIN',
  DIAGNOSTIC_CENTER_ADMIN = 'DIAGNOSTIC_CENTER_ADMIN',
  LAB_STAFF = 'LAB_STAFF',
  CUSTOMER_SUPPORT = 'CUSTOMER_SUPPORT',
  FINANCE_OFFICER = 'FINANCE_OFFICER',
  ADMIN = 'ADMIN',
  SUPER_ADMIN = 'SUPER_ADMIN',
}

export enum PreferredLanguage {
  am = 'am',
  en = 'en',
}

export enum OtpPurpose {
  REGISTER = 'REGISTER',
  LOGIN = 'LOGIN',
  RESET = 'RESET',
  STEP_UP = 'STEP_UP',
}

export enum LoginOutcome {
  SUCCESS = 'SUCCESS',
  FAILED = 'FAILED',
  LOCKED = 'LOCKED',
  MFA_REQUIRED = 'MFA_REQUIRED',
}

export enum VerificationType {
  FAYDA = 'FAYDA',
  PHARMACY_LICENSE = 'PHARMACY_LICENSE',
  DRIVER_DOCS = 'DRIVER_DOCS',
  DOCTOR_LICENSE = 'DOCTOR_LICENSE',
}

/**
 * Module-01 §9.3 describes NOT_STARTED → PENDING → UNDER_REVIEW → APPROVED | REJECTED | EXPIRED.
 * NOT_STARTED is the absence of a row and UNDER_REVIEW has no persisted representation in the
 * frozen Prisma enum, so the stored lifecycle is PENDING → APPROVED | REJECTED | EXPIRED.
 */
export enum VerificationStatus {
  PENDING = 'PENDING',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
  EXPIRED = 'EXPIRED',
}

export enum ConsentType {
  DATA_PROCESSING = 'DATA_PROCESSING',
  HEALTH_DATA_SHARING = 'HEALTH_DATA_SHARING',
  MARKETING = 'MARKETING',
  BENEFICIARY_DATA_MGMT = 'BENEFICIARY_DATA_MGMT',
}

export enum DevicePlatform {
  ANDROID = 'ANDROID',
  IOS = 'IOS',
  WEB = 'WEB',
}

/** Roles that self-register as customers today (this slice). Others are invited/provisioned. */
export const SELF_REGISTERABLE_ROLES: ReadonlySet<PrimaryRole> = new Set([PrimaryRole.CUSTOMER]);
