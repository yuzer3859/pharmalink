import { createDomainEvent, DomainEvent } from '../../../shared/events/domain-event';
import { ApiException } from '../../../shared/errors/api-exception';
import { ErrorCode } from '../../../shared/errors/error-codes';
import { ETHIOPIA_UTC_OFFSET_MINUTES } from './slot-generation';

/** Work 168 policy (module-10 BRULE-32/33), one home for the time windows. */
export const AppointmentPolicy = {
  /** A slot must start at least this long after booking. */
  MIN_LEAD_MINUTES: 30,
  /** A patient cancels or reschedules up to this long before the start. */
  CHANGE_CUTOFF_HOURS: 2,
  /** A patient holds at most this many upcoming appointments. */
  MAX_UPCOMING: 5,
  /** A doctor may check a patient in from this long before the start. */
  CHECK_IN_EARLY_MINUTES: 60,
} as const;

export const ACTIVE_STATUSES = ['PENDING_PAYMENT', 'CONFIRMED', 'CHECKED_IN', 'IN_PROGRESS'] as const;

export const AppointmentErrors = {
  notFound: () => new ApiException(ErrorCode.APPOINTMENT_NOT_FOUND, 'Appointment not found.'),
  slotUnavailable: (reason: 'TAKEN' | 'TOO_SOON' | 'TYPE' | 'NOT_FOUND') =>
    new ApiException(ErrorCode.SLOT_UNAVAILABLE, 'This time is no longer available. Choose another one.', { reason }),
  cancelClosed: () =>
    new ApiException(ErrorCode.CANCELLATION_WINDOW_CLOSED, `Appointments can be cancelled up to ${AppointmentPolicy.CHANGE_CUTOFF_HOURS} hours before they start.`),
  rescheduleClosed: () =>
    new ApiException(ErrorCode.RESCHEDULE_WINDOW_CLOSED, `Appointments can be moved up to ${AppointmentPolicy.CHANGE_CUTOFF_HOURS} hours before they start.`),
  invalidState: (status: string, action: string) =>
    new ApiException(ErrorCode.INVALID_APPOINTMENT_STATE, `A ${status.toLowerCase().replace(/_/g, ' ')} appointment cannot be ${action}.`, { status }),
};

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Mon 30 Nov 2026, 09:00" in Addis Ababa time, for notifications. */
export function localLabel(at: Date): string {
  const t = new Date(at.getTime() + ETHIOPIA_UTC_OFFSET_MINUTES * 60_000);
  const hh = String(t.getUTCHours()).padStart(2, '0');
  const mm = String(t.getUTCMinutes()).padStart(2, '0');
  return `${DAYS[t.getUTCDay()]} ${t.getUTCDate()} ${MONTHS[t.getUTCMonth()]} ${t.getUTCFullYear()}, ${hh}:${mm}`;
}

/** Work 168: appointment events (module-10 §9), written to the outbox with the change. */
export const AppointmentEventType = {
  Booked: 'appointment.appointment.booked',
  Cancelled: 'appointment.appointment.cancelled',
  Rescheduled: 'appointment.appointment.rescheduled',
  Completed: 'appointment.appointment.completed',
  NoShow: 'appointment.appointment.no_show',
} as const;

export interface AppointmentEventPayload {
  appointmentId: string;
  doctorId: string;
  patientUserId: string;
  doctorUserId: string;
  /** Both, for notifications; each gets their own wording. */
  recipientUserIds: string[];
  doctorName: string;
  appointmentType: string;
  startsAt: string;
  /** "Mon 30 Nov 2026, 09:00" (Addis Ababa). */
  startsAtLabel: string;
  /** Who did it: the patient or the doctor. */
  by?: 'PATIENT' | 'DOCTOR';
  /** Rescheduled: the earlier time's label. */
  previousLabel?: string;
}

export function appointmentEvent(type: (typeof AppointmentEventType)[keyof typeof AppointmentEventType], payload: AppointmentEventPayload): DomainEvent<AppointmentEventPayload> {
  return createDomainEvent({ type, aggregateType: 'Appointment', aggregateId: payload.appointmentId, payload });
}
