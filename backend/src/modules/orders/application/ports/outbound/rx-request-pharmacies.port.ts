export const RX_REQUEST_PHARMACIES_PORT = Symbol('ORDERS_RX_REQUEST_PHARMACIES_PORT');

export interface EligibleRxPharmacy {
  pharmacyId: string;
  /** The pharmacy's branch nearest the delivery address. */
  branchId: string;
  distanceMeters: number;
}

export interface PharmacistPharmacy {
  pharmacyId: string;
  organizationId: string;
}

/**
 * Work 134 (owner decision 2026-11-17): who a prescription request goes to, read from Modules 01
 * and 04's tables. Read-only.
 *
 * A pharmacy is eligible when it can take orders — its organisation is approved (`ACTIVE`), the
 * pharmacy is live and transacting (`ACTIVE`, licence `VALID` and unexpired, the same rule as
 * customer availability), it has at least one PHARMACIST to review the prescription, and one of its
 * active branches with a map location is within `radiusMeters` of the delivery address.
 */
export interface IRxRequestPharmaciesPort {
  findEligible(point: { lat: number; lng: number }, radiusMeters: number, now: Date): Promise<EligibleRxPharmacy[]>;
  /** Per pharmacy: its organisation owner and every PHARMACIST there — who hears about a request. */
  staffUserIds(pharmacyIds: string[]): Promise<Map<string, string[]>>;
  /** The pharmacies where `userId` holds the PHARMACIST role — whose requests they may act on. */
  pharmaciesWherePharmacist(userId: string): Promise<PharmacistPharmacy[]>;
  /** The pharmacies `userId` has any role at — whose requests they may see. */
  pharmaciesOfStaff(userId: string): Promise<PharmacistPharmacy[]>;
  displayNames(pharmacyIds: string[]): Promise<Map<string, string>>;
  /** The customer's name from their profile — never contact data — for the pharmacies offered a request. */
  customerNames(userIds: string[]): Promise<Map<string, string | null>>;
  /** What a pharmacist sees of a prescription before opening its file. */
  prescriptionSummaries(prescriptionIds: string[]): Promise<Map<string, RxPrescriptionSummary>>;
}

export interface RxPrescriptionSummary {
  id: string;
  fileType: string | null;
  doctorName: string | null;
  hospitalName: string | null;
  uploadedAt: Date;
}
