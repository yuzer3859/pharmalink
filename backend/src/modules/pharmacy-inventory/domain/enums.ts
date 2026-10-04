/**
 * Re-exported Prisma enums (module-04 §3.8), same pattern as Module 02/03's `domain/enums.ts` —
 * the domain layer depends on the enum shape, not on `@prisma/client` as a whole.
 */
export {
  TransactingStatus,
  LicenseStatus,
  StockMovementType,
  StockMovementRefType,
  ReservationStatus,
  ServiceZoneType,
  ImportStatus,
  StorageRequirement,
} from '@prisma/client';
