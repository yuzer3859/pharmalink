import type { DoctorStatus } from '../../../domain/doctor-rules';

export const DOCTOR_ADMIN_PORT = Symbol('DOCTOR_ADMIN_PORT');

export interface DoctorAffiliationView {
  providerId: string;
  providerName: string;
  providerType: string;
  departmentId: string | null;
  departmentName: string | null;
  roleTitle: string | null;
  isPrimary: boolean;
}

export interface DoctorListItem {
  doctorId: string;
  userId: string;
  fullName: string;
  specialty: string | null;
  status: DoctorStatus;
  isVerified: boolean;
  licenseNumber: string | null;
  licenseExpiresAt: Date | null;
  createdAt: Date;
}

export interface DoctorRecord extends DoctorListItem {
  fullNameAm: string | null;
  subSpecialties: string[];
  qualifications: string[];
  yearsExperience: number | null;
  bio: string | null;
  languages: string[];
  consultationFeeInPerson: number | null;
  consultationFeeTele: number | null;
  currency: string;
  acceptsTelemedicine: boolean;
  ratingAvg: number;
  ratingCount: number;
  affiliations: DoctorAffiliationView[];
}

export interface RegisterDoctorProfileInput {
  actorUserId: string;
  userId: string;
  fullName: string;
  fullNameAm?: string | null;
  specialty: string;
  licenseNumber: string;
  licenseExpiresAt: Date;
}

/**
 * Work 166: Module 10's doctor steps for a platform administrator — the professional profile of a
 * registered doctor, its record, and the manual Disable / Enable (module-10 §3.1, §5.3).
 */
export interface IDoctorAdminPort {
  findByUser(userId: string): Promise<{ doctorId: string } | null>;
  /** Creates the profile once per account; a repeat returns the existing one. */
  createProfile(input: RegisterDoctorProfileInput): Promise<{ doctorId: string }>;
  list(filter: { q?: string; specialty?: string; status?: DoctorStatus }, page: number, size: number): Promise<{ items: DoctorListItem[]; total: number }>;
  get(doctorId: string): Promise<DoctorRecord | null>;
  /** `false` when it was already suspended. */
  suspend(input: { actorUserId: string; doctorId: string; reason: string }): Promise<boolean>;
  /** `false` when it was already active. Refused when the licence has expired. */
  reactivate(input: { actorUserId: string; doctorId: string }): Promise<boolean>;
}
