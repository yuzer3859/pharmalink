import { randomInt } from 'crypto';
import { createDomainEvent, DomainEvent } from '../../../shared/events/domain-event';
import { ApiException } from '../../../shared/errors/api-exception';
import { ErrorCode } from '../../../shared/errors/error-codes';
import { localLabel } from '../../doctors/domain/appointment-rules';

/** Work 172 policy for lab bookings (module-11 BRULE-32/33/35/36). */
export const LabPolicy = {
  /** A slot must start at least this long after booking. */
  MIN_LEAD_MINUTES: 30,
  /** A patient cancels up to this long before the start. */
  CANCEL_CUTOFF_HOURS: 2,
  /** At most this many upcoming lab bookings per patient. */
  MAX_UPCOMING: 5,
  /** At most this many tests in one booking. */
  MAX_ITEMS: 10,
  /** Slots are created at most this far ahead, and at most this many at once. */
  MAX_SLOT_DAYS: 60,
  MAX_SLOTS_PER_REQUEST: 2000,
} as const;

export const ACTIVE_BOOKING_STATUSES = ['PENDING_PAYMENT', 'CONFIRMED', 'CHECKED_IN', 'SAMPLE_COLLECTED', 'PROCESSING'] as const;

/** Labs and diagnostic centres run lab bookings (module-09 §5.3). */
export const LAB_PROVIDER_TYPES = ['LAB', 'DIAGNOSTIC_CENTER'];

export const LabErrors = {
  notFound: () => new ApiException(ErrorCode.DIAGNOSTIC_BOOKING_NOT_FOUND, 'Lab booking not found.'),
  slotUnavailable: (reason: 'FULL' | 'TOO_SOON' | 'NOT_FOUND' | 'LOCATION') =>
    new ApiException(ErrorCode.SLOT_UNAVAILABLE, 'This time is no longer available. Choose another one.', { reason }),
  prepNotAcknowledged: (services: string[]) =>
    new ApiException(ErrorCode.PREP_NOT_ACKNOWLEDGED, 'Confirm that you have read how to prepare for these tests.', { services }),
  cancelClosed: () => new ApiException(ErrorCode.CANCELLATION_WINDOW_CLOSED, `Lab bookings can be cancelled up to ${LabPolicy.CANCEL_CUTOFF_HOURS} hours before they start.`),
  notALab: () => ApiException.businessRule('Only laboratories and diagnostic centres take lab bookings.', { code: 'NOT_A_LAB' }),
};

/** "LAB-261130-482913": the day booked and six random digits, easy to read out at the desk. */
export function bookingNumber(now = new Date()): string {
  const d = now.toISOString().slice(2, 10).replace(/-/g, '');
  return `LAB-${d}-${String(randomInt(0, 1_000_000)).padStart(6, '0')}`;
}

/** Work 172: lab booking events, written to the outbox with the change. */
export const LabEventType = {
  Booked: 'diagnostics.booking.booked',
  Cancelled: 'diagnostics.booking.cancelled',
} as const;

export interface LabEventPayload {
  bookingId: string;
  bookingNumber: string;
  providerId: string;
  patientUserId: string;
  /** For notifications. */
  recipientUserIds: string[];
  providerName: string;
  testCount: number;
  scheduledAt: string | null;
  /** "Mon 30 Nov 2026, 09:00" (Addis Ababa). */
  scheduledLabel: string | null;
  by?: 'PATIENT' | 'LAB';
}

export function labEvent(type: (typeof LabEventType)[keyof typeof LabEventType], payload: LabEventPayload): DomainEvent<LabEventPayload> {
  return createDomainEvent({ type, aggregateType: 'DiagnosticBooking', aggregateId: payload.bookingId, payload });
}

export const labelOf = (at: Date | null) => (at ? localLabel(at) : null);
