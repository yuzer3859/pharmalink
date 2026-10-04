/**
 * Domain enums for the Catalog bounded context (module-03 §3, backend/docs/03-catalog-spec.md).
 * Framework-free and mirror the string values of the Prisma enums
 * (backend/prisma/schema/03-catalog.prisma) so repository adapters can map 1:1 without a
 * translation table, while the domain stays free of any Prisma import (same discipline as
 * Module 02's `domain/enums.ts`).
 */

export enum ProductType {
  MEDICINE = 'MEDICINE',
  HEALTH_PRODUCT = 'HEALTH_PRODUCT',
}

export enum RxClassification {
  RX = 'RX',
  OTC = 'OTC',
}

export enum ControlledSchedule {
  NONE = 'NONE',
  SCHEDULE_1 = 'SCHEDULE_1',
  SCHEDULE_2 = 'SCHEDULE_2',
  SCHEDULE_3 = 'SCHEDULE_3',
  SCHEDULE_4 = 'SCHEDULE_4',
  SCHEDULE_5 = 'SCHEDULE_5',
  PROHIBITED = 'PROHIBITED',
}

export enum StorageRequirement {
  AMBIENT = 'AMBIENT',
  COLD_CHAIN = 'COLD_CHAIN',
  CONTROLLED_TEMP = 'CONTROLLED_TEMP',
}

export enum ProductStatus {
  DRAFT = 'DRAFT',
  PENDING_REVIEW = 'PENDING_REVIEW',
  ACTIVE = 'ACTIVE',
  DEPRECATED = 'DEPRECATED',
  DELISTED = 'DELISTED',
}

export enum CategoryAppliesTo {
  MEDICINE = 'MEDICINE',
  HEALTH_PRODUCT = 'HEALTH_PRODUCT',
  BOTH = 'BOTH',
}

/** Slice 1 allowlist (03-catalog-spec.md §3.1) — kept narrow so dedup/equivalence keys stay
 * stable for a future slice, rather than accepting a free-text dosage form. */
export const DOSAGE_FORM_ALLOWLIST: readonly string[] = [
  'TABLET',
  'CAPSULE',
  'SYRUP',
  'INJECTION',
  'CREAM',
  'OINTMENT',
  'DROPS',
  'INHALER',
  'OTHER',
];

export const STRENGTH_UNIT_ALLOWLIST: readonly string[] = ['MG', 'ML', 'G', 'MCG', 'IU', 'PERCENT'];

export const MANUFACTURER_STATUS_ALLOWLIST: readonly string[] = ['ACTIVE', 'INACTIVE'];

/** `^[A-Z]\d{2}[A-Z]{2}\d{2}$`, e.g. "N02BE01" — format-only check, not a real ATC registry
 * lookup in Slice 1 (§3.1). */
export const ATC_CODE_REGEX = /^[A-Z]\d{2}[A-Z]{2}\d{2}$/;

/** Category slug format (§3.2): unique, URL-safe, immutable after create. */
export const CATEGORY_SLUG_REGEX = /^[a-z0-9-]{2,80}$/;

/** Abuse guard on category tree depth (§3.6 invariant 5). */
export const MAX_CATEGORY_DEPTH = 6;
