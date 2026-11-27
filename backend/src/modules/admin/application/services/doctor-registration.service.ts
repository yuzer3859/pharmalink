import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../../../shared/audit/audit.service';
import { ApiException } from '../../../../shared/errors/api-exception';
import { ErrorCode } from '../../../../shared/errors/error-codes';
import { DOCTOR_ADMIN_PORT, type DoctorRecord, type IDoctorAdminPort } from '../../../doctors/application/ports/inbound/doctor-admin.port';
import type { DoctorStatus } from '../../../doctors/domain/doctor-rules';
import { IDENTITY_ADMIN_PORT, type IIdentityAdminPort } from '../../../identity/application/ports/inbound/identity-admin.port';
import {
  IDENTITY_DOCTOR_ONBOARDING_PORT,
  type DoctorDocument,
  type IIdentityDoctorOnboardingPort,
} from '../../../identity/application/ports/inbound/identity-doctor-onboarding.port';
import {
  IDENTITY_ORGANIZATION_READ_PORT,
  type IIdentityOrganizationReadPort,
} from '../../../identity/application/ports/inbound/identity-organization-read.port';
import { endOfDayUtc } from './pharmacy-registration.service';

export interface RegisterDoctorInput {
  actorUserId: string;
  userId: string;
  fullName: string;
  fullNameAm?: string;
  specialty: string;
  licenseNumber: string;
  /** The medical licence's last valid day (`YYYY-MM-DD`); it expires at the end of that day (UTC). */
  licenseExpiresOn: string;
  documents: DoctorDocument[];
  ip: string | null;
}

/**
 * Work 166: the Super Admin registers a doctor — an existing customer account becomes a doctor,
 * their medical licence and certificates are stored under them and approved with the licence's
 * expiry, and their professional profile is created, listed at once. Each step is the owning
 * module's own command; the whole is audited as `DOCTOR_REGISTERED_BY_ADMIN`. A repeat continues
 * where a failure stopped: an existing doctor account and profile are reused.
 *
 * Disable both hides the doctor and suspends their account; Enable restores both, on a licence
 * that has not expired.
 */
@Injectable()
export class DoctorRegistrationService {
  constructor(
    @Inject(IDENTITY_DOCTOR_ONBOARDING_PORT) private readonly identity: IIdentityDoctorOnboardingPort,
    @Inject(IDENTITY_ADMIN_PORT) private readonly accounts: IIdentityAdminPort,
    @Inject(IDENTITY_ORGANIZATION_READ_PORT) private readonly people: IIdentityOrganizationReadPort,
    @Inject(DOCTOR_ADMIN_PORT) private readonly doctors: IDoctorAdminPort,
    private readonly audit: AuditService,
  ) {}

  requestUpload(input: { userId: string; contentType: string; bytes: number; ip: string | null }) {
    return this.identity.requestDoctorDocumentUpload(input);
  }

  async register(input: RegisterDoctorInput): Promise<{ userId: string; doctorId: string }> {
    const expiresAt = endOfDayUtc(input.licenseExpiresOn);
    if (!expiresAt) throw new ApiException(ErrorCode.VALIDATION_ERROR, 'The licence expiry must be a date.', { field: 'licenseExpiresOn' });
    if (expiresAt.getTime() <= Date.now()) {
      throw new ApiException(ErrorCode.VALIDATION_ERROR, 'The licence has already expired.', { field: 'licenseExpiresOn' });
    }

    const existing = await this.doctors.findByUser(input.userId);
    let requestId: string | null = null;
    if (!existing) {
      await this.identity.makeDoctor({ userId: input.userId, actorUserId: input.actorUserId, ip: input.ip });
      ({ requestId } = await this.identity.submitDoctorLicence({ userId: input.userId, documents: input.documents, ip: input.ip }));
      await this.identity.approveDoctorLicence({ requestId, reviewerId: input.actorUserId, expiresAt, ip: input.ip });
    }
    const { doctorId } =
      existing ??
      (await this.doctors.createProfile({
        actorUserId: input.actorUserId,
        userId: input.userId,
        fullName: input.fullName,
        fullNameAm: input.fullNameAm ?? null,
        specialty: input.specialty,
        licenseNumber: input.licenseNumber,
        licenseExpiresAt: expiresAt,
      }));

    await this.audit.record({
      actorUserId: input.actorUserId,
      action: 'DOCTOR_REGISTERED_BY_ADMIN',
      resourceType: 'DoctorProfile',
      resourceId: doctorId,
      context: { userId: input.userId, verificationRequestId: requestId, licenseNumber: input.licenseNumber.trim(), documentCount: input.documents.length },
      ip: input.ip,
    });
    return { userId: input.userId, doctorId };
  }

  list(filter: { q?: string; specialty?: string; status?: DoctorStatus }, page: number, size: number) {
    return this.doctors.list(filter, page, size);
  }

  /** The doctor's record with their account (e-mail, phone, account status). */
  async get(doctorId: string): Promise<DoctorRecord & { account: { email: string | null; phone: string | null; status: string } | null }> {
    const record = await this.doctors.get(doctorId);
    if (!record) throw new ApiException(ErrorCode.DOCTOR_NOT_FOUND, 'Doctor not found.');
    const [account] = await this.people.accountsById([record.userId]);
    return { ...record, account: account ? { email: account.email, phone: account.phone, status: account.status } : null };
  }

  async suspend(input: { actorUserId: string; doctorId: string; reason: string; ip: string | null }) {
    const record = await this.mustGet(input.doctorId);
    const suspended = await this.doctors.suspend({ actorUserId: input.actorUserId, doctorId: input.doctorId, reason: input.reason });
    await this.accounts.suspendUser({ targetUserId: record.userId, actorUserId: input.actorUserId, reason: input.reason.trim(), ip: input.ip });
    return { suspended };
  }

  async reactivate(input: { actorUserId: string; doctorId: string; ip: string | null }) {
    const record = await this.mustGet(input.doctorId);
    const reactivated = await this.doctors.reactivate({ actorUserId: input.actorUserId, doctorId: input.doctorId });
    await this.accounts.reactivateUser({ targetUserId: record.userId, actorUserId: input.actorUserId, ip: input.ip });
    return { reactivated };
  }

  private async mustGet(doctorId: string) {
    const record = await this.doctors.get(doctorId);
    if (!record) throw new ApiException(ErrorCode.DOCTOR_NOT_FOUND, 'Doctor not found.');
    return record;
  }
}
