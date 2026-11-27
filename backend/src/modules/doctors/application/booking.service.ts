import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuditService } from '../../../shared/audit/audit.service';
import { ApiException } from '../../../shared/errors/api-exception';
import { ErrorCode } from '../../../shared/errors/error-codes';
import { OutboxService } from '../../../shared/outbox/outbox.service';
import { PrismaService } from '../../../shared/prisma/prisma.service';
import {
  IDENTITY_ORGANIZATION_READ_PORT,
  type IIdentityOrganizationReadPort,
} from '../../identity/application/ports/inbound/identity-organization-read.port';
import { PROVIDER_FACILITY_PORT, type IProviderFacilityPort } from '../../provider-directory/application/ports/inbound/provider-facility.port';
import {
  ACTIVE_STATUSES,
  appointmentEvent,
  AppointmentErrors,
  AppointmentEventType,
  AppointmentPolicy,
  localLabel,
  type AppointmentEventPayload,
} from '../domain/appointment-rules';
import { doctorEvent, DoctorErrors, DoctorEventType, isDoctorListed } from '../domain/doctor-rules';

type Tx = Prisma.TransactionClient;
type Actor = 'PATIENT' | 'DOCTOR';
type AppointmentRow = Prisma.AppointmentGetPayload<{ include: { slot: true; doctor: true } }>;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** A unique-constraint violation: a concurrent booking of the same slot won. */
const isUniqueViolation = (err: unknown) => err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';

/**
 * Work 168: booking doctors (module-10 §6, §7, §11). One active appointment per slot, guaranteed
 * twice: the slot moves OPEN → BOOKED with a single conditional update (zero rows updated means
 * someone else has it), and the database refuses a second active appointment on a slot. There is
 * no online payment yet (owner's default, 2026-11-27): an appointment is CONFIRMED when booked and
 * its fee, snapshotted at booking, is paid at the visit.
 *
 * Patients cancel or move an appointment up to 2 hours before it starts (BRULE-32/33); doctors
 * cancel, check in, complete and mark no-shows. Every transition appends to the status history,
 * is audited, and is announced on the outbox (`appointment.appointment.*`, and the doctor's
 * `availability_changed` for search) in the same transaction.
 */
@Injectable()
export class BookingService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(PROVIDER_FACILITY_PORT) private readonly facilities: IProviderFacilityPort,
    @Inject(IDENTITY_ORGANIZATION_READ_PORT) private readonly accounts: IIdentityOrganizationReadPort,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  // --- Patients -----------------------------------------------------------------------------

  async book(patientUserId: string, input: { slotId: string; appointmentType?: 'IN_PERSON' | 'TELEMEDICINE'; reasonNote?: string }) {
    const slot = await this.prisma.appointmentSlot.findUnique({ where: { id: input.slotId }, include: { doctor: true } });
    if (!slot) throw AppointmentErrors.slotUnavailable('NOT_FOUND');
    if (!isDoctorListed(slot.doctor)) throw DoctorErrors.notFound();
    if (slot.doctor.userId === patientUserId) throw ApiException.businessRule('You cannot book yourself.', { code: 'SELF_BOOKING' });

    // A repeat of a booking that already went through returns it.
    const mine = await this.prisma.appointment.findFirst({ where: { slotId: slot.id, patientUserId, status: { in: [...ACTIVE_STATUSES] } }, select: { id: true } });
    if (mine) return this.patientView(patientUserId, mine.id);

    const type = this.typeFor(slot.appointmentType, input.appointmentType);
    if (slot.startAt.getTime() < Date.now() + AppointmentPolicy.MIN_LEAD_MINUTES * MINUTE) throw AppointmentErrors.slotUnavailable('TOO_SOON');
    const upcoming = await this.prisma.appointment.count({ where: { patientUserId, status: { in: [...ACTIVE_STATUSES] }, scheduledStart: { gt: new Date() } } });
    if (upcoming >= AppointmentPolicy.MAX_UPCOMING) {
      throw ApiException.businessRule(`You can hold up to ${AppointmentPolicy.MAX_UPCOMING} upcoming appointments.`, { code: 'TOO_MANY_APPOINTMENTS' });
    }
    const fee = type === 'TELEMEDICINE' ? slot.doctor.consultationFeeTele : slot.doctor.consultationFeeInPerson;

    let appointmentId: string;
    try {
      appointmentId = await this.prisma.$transaction(async (tx) => {
        // The anti-double-booking guarantee: exactly one request moves the slot out of OPEN.
        const taken = await tx.appointmentSlot.updateMany({ where: { id: slot.id, status: 'OPEN', startAt: { gt: new Date() } }, data: { status: 'BOOKED', heldBy: null, heldUntil: null } });
        if (taken.count !== 1) throw AppointmentErrors.slotUnavailable('TAKEN');
        const created = await tx.appointment.create({
          data: {
            slotId: slot.id,
            doctorId: slot.doctorId,
            patientUserId,
            appointmentType: type,
            status: 'CONFIRMED',
            reasonNote: input.reasonNote?.trim() || null,
            fee,
            scheduledStart: slot.startAt,
            scheduledEnd: slot.endAt,
          },
          select: { id: true },
        });
        await tx.appointmentSlot.update({ where: { id: slot.id }, data: { appointmentId: created.id } });
        await this.history(tx, created.id, null, 'CONFIRMED', 'PATIENT', patientUserId, null);
        await this.audit.record({ actorUserId: patientUserId, action: 'APPOINTMENT_BOOKED', resourceType: 'Appointment', resourceId: created.id, context: { doctorId: slot.doctorId, slotId: slot.id, appointmentType: type } }, tx);
        await this.announce(tx, AppointmentEventType.Booked, created.id, slot.doctor, patientUserId, type, slot.startAt, { by: 'PATIENT' });
        return created.id;
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw AppointmentErrors.slotUnavailable('TAKEN');
      throw err;
    }
    return this.patientView(patientUserId, appointmentId);
  }

  async myAppointments(patientUserId: string, scope: 'upcoming' | 'past') {
    const now = new Date();
    const rows = await this.prisma.appointment.findMany({
      where:
        scope === 'upcoming'
          ? { patientUserId, status: { in: [...ACTIVE_STATUSES] }, scheduledEnd: { gt: now } }
          : { patientUserId, OR: [{ status: { notIn: [...ACTIVE_STATUSES] } }, { scheduledEnd: { lte: now } }], NOT: { status: 'RESCHEDULED' } },
      include: { slot: true, doctor: true },
      orderBy: { scheduledStart: scope === 'upcoming' ? 'asc' : 'desc' },
      take: 50,
    });
    return Promise.all(rows.map((r) => this.toPatientView(r)));
  }

  async patientView(patientUserId: string, appointmentId: string) {
    const row = await this.prisma.appointment.findFirst({ where: { id: appointmentId, patientUserId }, include: { slot: true, doctor: true } });
    if (!row) throw AppointmentErrors.notFound();
    return this.toPatientView(row);
  }

  async cancelByPatient(patientUserId: string, appointmentId: string, reason?: string) {
    const row = await this.prisma.appointment.findFirst({ where: { id: appointmentId, patientUserId }, include: { slot: true, doctor: true } });
    if (!row) throw AppointmentErrors.notFound();
    if (row.status !== 'CONFIRMED') throw AppointmentErrors.invalidState(row.status, 'cancelled');
    if (!this.changeable(row.scheduledStart)) throw AppointmentErrors.cancelClosed();
    await this.prisma.$transaction(async (tx) => {
      await this.transition(tx, row, 'CANCELLED', 'PATIENT', patientUserId, reason?.trim() || null);
      await this.freeSlot(tx, row.slotId, 'OPEN');
      await this.announce(tx, AppointmentEventType.Cancelled, row.id, row.doctor, row.patientUserId, row.appointmentType, row.scheduledStart, { by: 'PATIENT' });
    });
    return this.patientView(patientUserId, appointmentId);
  }

  async reschedule(patientUserId: string, appointmentId: string, newSlotId: string) {
    const row = await this.prisma.appointment.findFirst({ where: { id: appointmentId, patientUserId }, include: { slot: true, doctor: true } });
    if (!row) throw AppointmentErrors.notFound();
    if (row.status !== 'CONFIRMED') throw AppointmentErrors.invalidState(row.status, 'moved');
    if (!this.changeable(row.scheduledStart)) throw AppointmentErrors.rescheduleClosed();
    const slot = await this.prisma.appointmentSlot.findUnique({ where: { id: newSlotId } });
    if (!slot || slot.doctorId !== row.doctorId) throw AppointmentErrors.slotUnavailable('NOT_FOUND');
    if (slot.appointmentType !== 'BOTH' && slot.appointmentType !== row.appointmentType) throw AppointmentErrors.slotUnavailable('TYPE');
    if (slot.startAt.getTime() < Date.now() + AppointmentPolicy.MIN_LEAD_MINUTES * MINUTE) throw AppointmentErrors.slotUnavailable('TOO_SOON');

    let newId: string;
    try {
      newId = await this.prisma.$transaction(async (tx) => {
        // Hold the new time first, so the patient is never left with neither (module-10 §6).
        const taken = await tx.appointmentSlot.updateMany({ where: { id: slot.id, status: 'OPEN', startAt: { gt: new Date() } }, data: { status: 'BOOKED' } });
        if (taken.count !== 1) throw AppointmentErrors.slotUnavailable('TAKEN');
        await this.transition(tx, row, 'RESCHEDULED', 'PATIENT', patientUserId, null);
        await this.freeSlot(tx, row.slotId, 'OPEN');
        const created = await tx.appointment.create({
          data: {
            slotId: slot.id,
            doctorId: row.doctorId,
            patientUserId,
            appointmentType: row.appointmentType,
            status: 'CONFIRMED',
            reasonNote: row.reasonNote,
            fee: row.fee,
            scheduledStart: slot.startAt,
            scheduledEnd: slot.endAt,
            rescheduledFromId: row.id,
          },
          select: { id: true },
        });
        await tx.appointmentSlot.update({ where: { id: slot.id }, data: { appointmentId: created.id } });
        await this.history(tx, created.id, null, 'CONFIRMED', 'PATIENT', patientUserId, 'Rescheduled');
        await this.announce(tx, AppointmentEventType.Rescheduled, created.id, row.doctor, patientUserId, row.appointmentType, slot.startAt, {
          by: 'PATIENT',
          previousLabel: localLabel(row.scheduledStart),
        });
        return created.id;
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw AppointmentErrors.slotUnavailable('TAKEN');
      throw err;
    }
    return this.patientView(patientUserId, newId);
  }

  // --- Doctors ------------------------------------------------------------------------------

  async doctorAppointments(doctorUserId: string, input: { from?: Date; to?: Date; status?: string }) {
    const doctor = await this.ownDoctor(doctorUserId);
    const from = input.from ?? new Date(Date.now() - 24 * HOUR);
    const to = input.to ?? new Date(from.getTime() + 31 * 24 * HOUR);
    const rows = await this.prisma.appointment.findMany({
      where: { doctorId: doctor.id, scheduledStart: { gte: from, lt: to }, ...(input.status ? { status: input.status as never } : { NOT: { status: 'RESCHEDULED' } }) },
      include: { slot: true, doctor: true },
      orderBy: { scheduledStart: 'asc' },
      take: 500,
    });
    return this.withPatients(rows);
  }

  async doctorAction(doctorUserId: string, appointmentId: string, action: 'check-in' | 'complete' | 'no-show' | 'cancel', reason?: string) {
    const doctor = await this.ownDoctor(doctorUserId);
    const row = await this.prisma.appointment.findFirst({ where: { id: appointmentId, doctorId: doctor.id }, include: { slot: true, doctor: true } });
    if (!row) throw AppointmentErrors.notFound();
    const now = Date.now();
    const start = row.scheduledStart.getTime();

    if (action === 'check-in') {
      if (row.status !== 'CONFIRMED') throw AppointmentErrors.invalidState(row.status, 'checked in');
      if (now < start - AppointmentPolicy.CHECK_IN_EARLY_MINUTES * MINUTE) throw ApiException.businessRule('A patient can be checked in from an hour before the appointment.', { code: 'TOO_EARLY' });
      await this.prisma.$transaction((tx) => this.transition(tx, row, 'CHECKED_IN', 'DOCTOR', doctorUserId, null));
    } else if (action === 'complete') {
      if (!['CONFIRMED', 'CHECKED_IN', 'IN_PROGRESS'].includes(row.status)) throw AppointmentErrors.invalidState(row.status, 'completed');
      if (now < start - AppointmentPolicy.CHECK_IN_EARLY_MINUTES * MINUTE) throw ApiException.businessRule('An appointment is completed once it has taken place.', { code: 'TOO_EARLY' });
      await this.prisma.$transaction(async (tx) => {
        await this.transition(tx, row, 'COMPLETED', 'DOCTOR', doctorUserId, null);
        await this.announce(tx, AppointmentEventType.Completed, row.id, row.doctor, row.patientUserId, row.appointmentType, row.scheduledStart, { by: 'DOCTOR' });
      });
    } else if (action === 'no-show') {
      if (!['CONFIRMED', 'CHECKED_IN'].includes(row.status)) throw AppointmentErrors.invalidState(row.status, 'marked as a no-show');
      if (now < start) throw ApiException.businessRule('A no-show is marked after the appointment was due to start.', { code: 'TOO_EARLY' });
      await this.prisma.$transaction(async (tx) => {
        await this.transition(tx, row, 'NO_SHOW', 'DOCTOR', doctorUserId, null);
        await this.announce(tx, AppointmentEventType.NoShow, row.id, row.doctor, row.patientUserId, row.appointmentType, row.scheduledStart, { by: 'DOCTOR' });
      });
    } else {
      const why = (reason ?? '').trim();
      if (why.length < 3 || why.length > 500) throw DoctorErrors.reasonRequired();
      if (row.status !== 'CONFIRMED') throw AppointmentErrors.invalidState(row.status, 'cancelled');
      if (now >= start) throw AppointmentErrors.invalidState('STARTED', 'cancelled');
      await this.prisma.$transaction(async (tx) => {
        await this.transition(tx, row, 'CANCELLED', 'DOCTOR', doctorUserId, why);
        // The doctor is not available then: the time is not offered again.
        await this.freeSlot(tx, row.slotId, 'BLOCKED');
        await this.announce(tx, AppointmentEventType.Cancelled, row.id, row.doctor, row.patientUserId, row.appointmentType, row.scheduledStart, { by: 'DOCTOR' });
      });
    }
    const [view] = await this.withPatients([await this.prisma.appointment.findUniqueOrThrow({ where: { id: row.id }, include: { slot: true, doctor: true } })]);
    return view;
  }

  // --- Facilities ---------------------------------------------------------------------------

  /** A facility's appointments: those at its locations, from yesterday for 31 days by default. */
  async facilityAppointments(facilityUserId: string, input: { from?: Date; to?: Date }) {
    const facility = await this.facilities.callerFacility(facilityUserId);
    if (!facility) throw new ApiException(ErrorCode.PROVIDER_NOT_FOUND, 'Healthcare provider not found.');
    const locationIds = await this.facilities.locationIdsOf(facility.providerId);
    const from = input.from ?? new Date(Date.now() - 24 * HOUR);
    const to = input.to ?? new Date(from.getTime() + 31 * 24 * HOUR);
    const rows = await this.prisma.appointment.findMany({
      where: { slot: { providerLocationId: { in: locationIds } }, scheduledStart: { gte: from, lt: to }, NOT: { status: 'RESCHEDULED' } },
      include: { slot: true, doctor: true },
      orderBy: { scheduledStart: 'asc' },
      take: 1000,
    });
    return this.withPatients(rows);
  }

  // --- Helpers ------------------------------------------------------------------------------

  private typeFor(slotType: string, requested?: 'IN_PERSON' | 'TELEMEDICINE'): 'IN_PERSON' | 'TELEMEDICINE' {
    if (slotType === 'BOTH') {
      if (!requested) throw ApiException.validation('Choose in person or video for this time.', { field: 'appointmentType' });
      return requested;
    }
    if (requested && requested !== slotType) throw AppointmentErrors.slotUnavailable('TYPE');
    return slotType as 'IN_PERSON' | 'TELEMEDICINE';
  }

  private changeable(start: Date): boolean {
    return start.getTime() - Date.now() >= AppointmentPolicy.CHANGE_CUTOFF_HOURS * HOUR;
  }

  private async ownDoctor(userId: string) {
    const doctor = await this.prisma.doctorProfile.findFirst({ where: { userId, deletedAt: null } });
    if (!doctor) throw DoctorErrors.notFound();
    return doctor;
  }

  /** Conditional on the status read, so two concurrent changes resolve to one. */
  private async transition(tx: Tx, row: AppointmentRow, to: 'CANCELLED' | 'RESCHEDULED' | 'CHECKED_IN' | 'COMPLETED' | 'NO_SHOW', actor: Actor, actorId: string, reason: string | null) {
    const updated = await tx.appointment.updateMany({
      where: { id: row.id, status: row.status },
      data: { status: to, ...(to === 'CANCELLED' ? { cancelReason: reason } : {}) },
    });
    if (updated.count !== 1) throw AppointmentErrors.invalidState(row.status, 'changed now');
    await this.history(tx, row.id, row.status, to, actor, actorId, reason);
    await this.audit.record({ actorUserId: actorId, action: `APPOINTMENT_${to}`, resourceType: 'Appointment', resourceId: row.id, context: { from: row.status, by: actor, ...(reason ? { reason } : {}) } }, tx);
  }

  /** The slot is free again (OPEN) or kept off (BLOCKED); a past slot is left as it was. */
  private async freeSlot(tx: Tx, slotId: string, to: 'OPEN' | 'BLOCKED') {
    await tx.appointmentSlot.updateMany({ where: { id: slotId, status: 'BOOKED', startAt: { gt: new Date() } }, data: { status: to, appointmentId: null } });
  }

  private history(tx: Tx, appointmentId: string, from: string | null, to: string, actor: Actor, actorId: string, reason: string | null) {
    return tx.appointmentStatusHistory.create({ data: { appointmentId, fromStatus: from, toStatus: to, actorType: actor, actorId, reason } });
  }

  private async announce(
    tx: Tx,
    type: (typeof AppointmentEventType)[keyof typeof AppointmentEventType],
    appointmentId: string,
    doctor: { id: string; userId: string; fullName: string },
    patientUserId: string,
    appointmentType: string,
    startsAt: Date,
    extra: Pick<AppointmentEventPayload, 'by' | 'previousLabel'>,
  ) {
    await this.outbox.write(
      appointmentEvent(type, {
        appointmentId,
        doctorId: doctor.id,
        patientUserId,
        doctorUserId: doctor.userId,
        recipientUserIds: [patientUserId, doctor.userId],
        doctorName: doctor.fullName,
        appointmentType,
        startsAt: startsAt.toISOString(),
        startsAtLabel: localLabel(startsAt),
        ...extra,
      }),
      tx as never,
    );
    await this.outbox.write(doctorEvent(DoctorEventType.DoctorAvailabilityChanged, { doctorId: doctor.id }), tx as never);
  }

  private async locationOf(id: string | null) {
    if (!id) return null;
    const l = await this.facilities.locationOf(id);
    return l ? { locationId: l.locationId, providerId: l.providerId, name: l.name, city: l.city, lat: l.lat, lng: l.lng } : null;
  }

  private async toPatientView(r: AppointmentRow) {
    const location = await this.locationOf(r.slot.providerLocationId);
    const [facility] = location ? await this.facilities.summaries([location.providerId]) : [];
    return {
      appointmentId: r.id,
      status: r.status,
      appointmentType: r.appointmentType,
      startsAt: r.scheduledStart,
      endsAt: r.scheduledEnd,
      fee: r.fee,
      currency: r.doctor.currency,
      reasonNote: r.reasonNote,
      cancelReason: r.cancelReason,
      rescheduledFromId: r.rescheduledFromId,
      doctor: { doctorId: r.doctor.id, fullName: r.doctor.fullName, fullNameAm: r.doctor.fullNameAm, specialty: r.doctor.specialty },
      location: location ? { ...location, providerName: facility?.displayName ?? null } : null,
      canChange: r.status === 'CONFIRMED' && this.changeable(r.scheduledStart),
      payAt: 'VISIT' as const,
    };
  }

  /** For doctors and facilities: each appointment with how to reach the patient. */
  private async withPatients(rows: AppointmentRow[]) {
    const people = await this.accounts.accountsById([...new Set(rows.map((r) => r.patientUserId))]);
    return Promise.all(
      rows.map(async (r) => {
        const p = people.find((x) => x.userId === r.patientUserId);
        return {
          appointmentId: r.id,
          status: r.status,
          appointmentType: r.appointmentType,
          startsAt: r.scheduledStart,
          endsAt: r.scheduledEnd,
          fee: r.fee,
          currency: r.doctor.currency,
          reasonNote: r.reasonNote,
          cancelReason: r.cancelReason,
          doctor: { doctorId: r.doctor.id, fullName: r.doctor.fullName },
          patient: { userId: r.patientUserId, email: p?.email ?? null, phone: p?.phone ?? null },
          location: await this.locationOf(r.slot.providerLocationId),
        };
      }),
    );
  }
}
