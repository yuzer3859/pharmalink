import { createDomainEvent, DomainEvent } from '../../../shared/events/domain-event';
import { ApiException } from '../../../shared/errors/api-exception';
import { ErrorCode } from '../../../shared/errors/error-codes';

export const DOCTOR_STATUSES = ['ACTIVE', 'SUSPENDED'] as const;
export type DoctorStatus = (typeof DOCTOR_STATUSES)[number];

/** A doctor appears and can be booked while ACTIVE, verified, and on a licence that has not expired. */
export function isDoctorListed(d: { status: string; isVerified: boolean; licenseExpiresAt: Date | null; deletedAt?: Date | null }, now = Date.now()): boolean {
  return d.status === 'ACTIVE' && d.isVerified && !d.deletedAt && (!d.licenseExpiresAt || d.licenseExpiresAt.getTime() > now);
}

export const DoctorErrors = {
  notFound: () => new ApiException(ErrorCode.DOCTOR_NOT_FOUND, 'Doctor not found.'),
  notListed: (reason: 'SUSPENDED' | 'LICENSE_EXPIRED' | 'NOT_VERIFIED') =>
    new ApiException(ErrorCode.DOCTOR_NOT_VERIFIED, 'This doctor is not available on PharmaLink.', { reason }),
  reasonRequired: () => ApiException.validation('Give a reason of 3 to 500 characters.', { field: 'reason' }),
};

/** Work 166: Module 10 doctor events, written to the outbox with the change. */
export const DoctorEventType = {
  DoctorActivated: 'doctor.doctor.activated',
  DoctorSuspended: 'doctor.doctor.suspended',
  /** The profile, a fee or an affiliation changed. */
  DoctorProfileChanged: 'doctor.doctor.profile_changed',
  /** Work 167: the doctor's slots changed (availability, a block, a booking). */
  DoctorAvailabilityChanged: 'doctor.doctor.availability_changed',
} as const;

export interface DoctorEventPayload {
  doctorId: string;
  /** For `suspended`: `MANUAL` or `LICENSE_EXPIRED`; for `profile_changed`: the audit action. */
  reason?: string;
}

export function doctorEvent(type: (typeof DoctorEventType)[keyof typeof DoctorEventType], payload: DoctorEventPayload): DomainEvent<DoctorEventPayload> {
  return createDomainEvent({ type, aggregateType: 'DoctorProfile', aggregateId: payload.doctorId, payload });
}
