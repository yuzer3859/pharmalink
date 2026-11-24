import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../../../shared/audit/audit.service';
import { ApiException } from '../../../../shared/errors/api-exception';
import { ErrorCode } from '../../../../shared/errors/error-codes';
import {
  DRIVER_ONBOARDING_PORT,
  type DriverProfileRecord,
  type IDriverOnboardingPort,
} from '../../../delivery/application/ports/inbound/driver-onboarding.port';
import {
  IDENTITY_DRIVER_ONBOARDING_PORT,
  type DriverDocument,
  type IIdentityDriverOnboardingPort,
} from '../../../identity/application/ports/inbound/identity-driver-onboarding.port';

export interface RegisterDriverInput {
  actorUserId: string;
  userId: string;
  vehicleType: string;
  plateNumber: string | null;
  /** The documents' last valid day (the earliest expiry among them); they expire at its end, UTC. */
  documentsExpireOn: string;
  documents: DriverDocument[];
  serviceArea: { lat: number; lng: number; radiusMeters: number } | null;
  ip: string | null;
}

const endOfDayUtc = (day: string): Date | null => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const date = new Date(`${day}T23:59:59.999Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== day ? null : date;
};

/**
 * Work 156: the Super Admin registers a driver — an existing customer account becomes a driver,
 * their documents (driving licence, vehicle registration, ID) are stored under them and approved
 * with an expiry, and their delivery profile (vehicle, plate, service area) is created. They can
 * then sign in to the driver app and go online. Each step is the module's own command; the whole
 * is audited as `DRIVER_REGISTERED_BY_ADMIN`. Disabling a driver is suspending their account
 * (`POST /admin/accounts/:id/suspend`): delivery re-checks the account before every offer,
 * acceptance and going online.
 */
@Injectable()
export class DriverRegistrationService {
  constructor(
    @Inject(IDENTITY_DRIVER_ONBOARDING_PORT) private readonly identity: IIdentityDriverOnboardingPort,
    @Inject(DRIVER_ONBOARDING_PORT) private readonly delivery: IDriverOnboardingPort,
    private readonly audit: AuditService,
  ) {}

  requestUpload(input: { userId: string; contentType: string; bytes: number; ip: string | null }) {
    return this.identity.requestDriverDocumentUpload(input);
  }

  profileOf(userId: string): Promise<DriverProfileRecord | null> {
    return this.delivery.profileOf(userId);
  }

  async register(input: RegisterDriverInput): Promise<{ userId: string; profile: DriverProfileRecord }> {
    const expiresAt = endOfDayUtc(input.documentsExpireOn);
    if (!expiresAt) throw new ApiException(ErrorCode.VALIDATION_ERROR, 'The documents’ expiry must be a date.', { field: 'documentsExpireOn' });
    if (expiresAt.getTime() <= Date.now()) {
      throw new ApiException(ErrorCode.VALIDATION_ERROR, 'The documents have already expired.', { field: 'documentsExpireOn' });
    }

    await this.identity.makeDriver({ userId: input.userId, actorUserId: input.actorUserId, ip: input.ip });
    const { requestId } = await this.identity.submitDriverDocuments({ userId: input.userId, documents: input.documents, ip: input.ip });
    await this.identity.approveDriverDocuments({ requestId, reviewerId: input.actorUserId, expiresAt, ip: input.ip });
    const profile = await this.delivery.createProfile({
      userId: input.userId,
      actorUserId: input.actorUserId,
      vehicleType: input.vehicleType,
      plateNumber: input.plateNumber?.trim() || null,
      serviceArea: input.serviceArea,
    });

    await this.audit.record({
      actorUserId: input.actorUserId,
      action: 'DRIVER_REGISTERED_BY_ADMIN',
      resourceType: 'user',
      resourceId: input.userId,
      context: { driverProfileId: profile.driverProfileId, verificationRequestId: requestId, documentCount: input.documents.length },
      ip: input.ip,
    });
    return { userId: input.userId, profile };
  }
}
