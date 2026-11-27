export const DOCTOR_SEARCH_SOURCE_PORT = Symbol('DOCTOR_SEARCH_SOURCE_PORT');

export interface DoctorSearchSource {
  doctorId: string;
  /** Active, verified, on a current licence (Work 166). */
  listed: boolean;
  fullName: string;
  fullNameAm: string | null;
  specialty: string | null;
  subSpecialties: string[];
  languages: string[];
  consultationFeeInPerson: number | null;
  consultationFeeTele: number | null;
  currency: string;
  acceptsTelemedicine: boolean;
  ratingAvg: number;
  ratingCount: number;
  /** Eligible facilities only, primary first, with the facility's main location. */
  practices: Array<{ providerId: string; providerName: string; departmentName: string | null; city: string | null; lat: number | null; lng: number | null }>;
  /** The earliest open future slot, or `null`. */
  nextAvailableAt: Date | null;
}

/**
 * Work 167: what Module 14 indexes about a doctor (module-14 §6.1 `DoctorSearchDoc`). Read-only;
 * Search re-reads a doctor through this port on every doctor event.
 */
export interface IDoctorSearchSourcePort {
  doctorIds(): Promise<string[]>;
  doctor(doctorId: string): Promise<DoctorSearchSource | null>;
  /** The doctors practising at a facility, to refresh when the facility changes. */
  doctorIdsAt(providerId: string): Promise<string[]>;
}
