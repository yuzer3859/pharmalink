import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuditService } from '../../../shared/audit/audit.service';
import { ApiException } from '../../../shared/errors/api-exception';
import { OutboxService } from '../../../shared/outbox/outbox.service';
import { PrismaService } from '../../../shared/prisma/prisma.service';
import { PROVIDER_FACILITY_PORT, type IProviderFacilityPort } from '../../provider-directory/application/ports/inbound/provider-facility.port';
import { doctorEvent, DoctorErrors, DoctorEventType, isDoctorListed } from '../domain/doctor-rules';
import { BOOKING_HORIZON_DAYS, generateSlots, localInstant, type RuleInput, type RuleType, type SlotType } from '../domain/slot-generation';

const MAX_RULES = 60;
const MAX_RANGE_DAYS = 31;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface RuleForm {
  type: RuleType;
  weekday?: number;
  startTime?: string;
  endTime?: string;
  /** `YYYY-MM-DD` local. RECURRING: first day it applies (optional); exceptions: the day. */
  fromDate?: string;
  /** `YYYY-MM-DD` local. RECURRING only: last day it applies (optional). */
  toDate?: string;
  slotDurationMinutes?: number;
  bufferMinutes?: number;
  appointmentType: SlotType;
  providerLocationId?: string;
}

const minutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/**
 * Work 167: a doctor's availability and the bookable slots it makes (module-10 §3.2, §6, §11.4).
 *
 * Rules are recurring weekly patterns, one-off extra availability and blocked time, in local
 * Ethiopian time, each at one of the doctor's facilities' locations or none (telemedicine or
 * independent practice). Every change regenerates the doctor's future slots for the 60-day
 * horizon: missing OPEN slots are created (idempotent on doctor + start + type) and OPEN or
 * ad-hoc BLOCKED slots the rules no longer give are removed (or, when they carry a cancelled
 * appointment's history, blocked). HELD and BOOKED slots are never touched. A daily job extends the horizon. Booking (Work 168) holds a slot with one atomic
 * conditional update.
 */
@Injectable()
export class AvailabilityService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(PROVIDER_FACILITY_PORT) private readonly facilities: IProviderFacilityPort,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  async rules(userId: string) {
    const doctor = await this.ownDoctor(userId);
    const rows = await this.prisma.availabilityRule.findMany({ where: { doctorId: doctor.id }, orderBy: [{ type: 'asc' }, { weekday: 'asc' }, { validFrom: 'asc' }, { startTime: 'asc' }] });
    return rows.map((r) => ({
      ruleId: r.id,
      type: r.type,
      weekday: r.weekday,
      startTime: r.startTime,
      endTime: r.endTime,
      validFrom: r.validFrom,
      validTo: r.validTo,
      slotDurationMinutes: r.slotDurationMinutes,
      bufferMinutes: r.bufferMinutes,
      appointmentType: r.appointmentType,
      providerLocationId: r.providerLocationId,
    }));
  }

  async addRule(userId: string, form: RuleForm) {
    const doctor = await this.ownDoctor(userId);
    if ((await this.prisma.availabilityRule.count({ where: { doctorId: doctor.id } })) >= MAX_RULES) {
      throw ApiException.businessRule(`A doctor has at most ${MAX_RULES} availability rules.`, { code: 'TOO_MANY_RULES' });
    }
    const data = await this.validate(doctor, form);
    const rule = await this.prisma.$transaction(async (tx) => {
      const created = await tx.availabilityRule.create({ data: { ...data, doctorId: doctor.id }, select: { id: true } });
      await this.audit.record({ actorUserId: userId, action: 'DOCTOR_AVAILABILITY_ADDED', resourceType: 'DoctorProfile', resourceId: doctor.id, context: { ruleId: created.id, type: form.type } }, tx);
      return created;
    });
    const slots = await this.regenerate(doctor.id);
    return { ruleId: rule.id, slotsCreated: slots.created, slotsRemoved: slots.removed };
  }

  async removeRule(userId: string, ruleId: string) {
    const doctor = await this.ownDoctor(userId);
    const rule = await this.prisma.availabilityRule.findFirst({ where: { id: ruleId, doctorId: doctor.id } });
    if (!rule) throw ApiException.notFound('Availability rule not found.');
    await this.prisma.$transaction(async (tx) => {
      await tx.availabilityRule.delete({ where: { id: rule.id } });
      await this.audit.record({ actorUserId: userId, action: 'DOCTOR_AVAILABILITY_REMOVED', resourceType: 'DoctorProfile', resourceId: doctor.id, context: { ruleId: rule.id, type: rule.type } }, tx);
    });
    const slots = await this.regenerate(doctor.id);
    return { removed: true, slotsCreated: slots.created, slotsRemoved: slots.removed };
  }

  /** Ad-hoc: an OPEN slot becomes BLOCKED, or back (F-AVL-05). */
  async setSlotBlocked(userId: string, slotId: string, blocked: boolean) {
    const doctor = await this.ownDoctor(userId);
    const updated = await this.prisma.appointmentSlot.updateMany({
      where: { id: slotId, doctorId: doctor.id, status: blocked ? 'OPEN' : 'BLOCKED', startAt: { gt: new Date() } },
      data: { status: blocked ? 'BLOCKED' : 'OPEN' },
    });
    if (updated.count !== 1) {
      const exists = await this.prisma.appointmentSlot.findFirst({ where: { id: slotId, doctorId: doctor.id }, select: { status: true } });
      if (!exists) throw ApiException.notFound('Slot not found.');
      throw ApiException.conflict(blocked ? 'Only an open future slot can be blocked.' : 'Only a blocked future slot can be opened again.', { status: exists.status });
    }
    await this.audit.record({ actorUserId: userId, action: blocked ? 'DOCTOR_SLOT_BLOCKED' : 'DOCTOR_SLOT_UNBLOCKED', resourceType: 'AppointmentSlot', resourceId: slotId, context: { doctorId: doctor.id } });
    await this.outbox.write(doctorEvent(DoctorEventType.DoctorAvailabilityChanged, { doctorId: doctor.id }));
    return { slotId, status: blocked ? 'BLOCKED' : 'OPEN' };
  }

  /** The doctor's own calendar: every slot in the range, whatever its status. */
  async ownSlots(userId: string, from?: string, to?: string) {
    const doctor = await this.ownDoctor(userId);
    const range = this.range(from, to);
    const rows = await this.prisma.appointmentSlot.findMany({ where: { doctorId: doctor.id, startAt: { gte: range.from, lt: range.to } }, orderBy: { startAt: 'asc' } });
    return rows.map((s) => ({ slotId: s.id, startAt: s.startAt, endAt: s.endAt, appointmentType: s.appointmentType, providerLocationId: s.providerLocationId, status: s.status }));
  }

  /** What a patient can book: a listed doctor's OPEN future slots in the range (at most 31 days). */
  async openSlots(doctorId: string, input: { from?: string; to?: string; type?: 'IN_PERSON' | 'TELEMEDICINE'; locationId?: string }) {
    const doctor = await this.prisma.doctorProfile.findFirst({ where: { id: doctorId, deletedAt: null } });
    if (!doctor || !isDoctorListed(doctor)) throw DoctorErrors.notFound();
    const range = this.range(input.from, input.to);
    const now = new Date();
    const rows = await this.prisma.appointmentSlot.findMany({
      where: {
        doctorId,
        status: 'OPEN',
        startAt: { gte: range.from > now ? range.from : now, lt: range.to },
        ...(input.type ? { appointmentType: { in: [input.type, 'BOTH'] } } : {}),
        ...(input.locationId ? { providerLocationId: input.locationId } : {}),
      },
      orderBy: { startAt: 'asc' },
      take: 500,
    });
    const locations = new Map<string, Awaited<ReturnType<IProviderFacilityPort['locationOf']>>>();
    for (const id of new Set(rows.map((r) => r.providerLocationId).filter((v): v is string => !!v))) locations.set(id, await this.facilities.locationOf(id));
    return rows
      .filter((s) => !s.providerLocationId || locations.get(s.providerLocationId))
      .map((s) => {
        const at = s.providerLocationId ? locations.get(s.providerLocationId) : null;
        return {
          slotId: s.id,
          startAt: s.startAt,
          endAt: s.endAt,
          appointmentType: s.appointmentType,
          location: at ? { locationId: at.locationId, providerId: at.providerId, name: at.name, city: at.city } : null,
        };
      });
  }

  /** The earliest OPEN future slot, for search (`nextAvailableAt`). */
  async nextOpen(doctorId: string): Promise<Date | null> {
    const row = await this.prisma.appointmentSlot.findFirst({ where: { doctorId, status: 'OPEN', startAt: { gt: new Date() } }, orderBy: { startAt: 'asc' }, select: { startAt: true } });
    return row?.startAt ?? null;
  }

  /**
   * Brings the doctor's future slots in line with their rules for the horizon. Returns how many
   * slots were created and removed. Never touches HELD or BOOKED slots.
   */
  async regenerate(doctorId: string, now = new Date()): Promise<{ created: number; removed: number }> {
    const rules = await this.prisma.availabilityRule.findMany({ where: { doctorId } });
    const wanted = generateSlots(rules as unknown as RuleInput[], now, BOOKING_HORIZON_DAYS);
    const key = (s: { startAt: Date; appointmentType: string }) => `${s.startAt.toISOString()}|${s.appointmentType}`;
    const wantedKeys = new Set(wanted.map(key));
    const existing = await this.prisma.appointmentSlot.findMany({ where: { doctorId, startAt: { gt: now } }, select: { id: true, startAt: true, appointmentType: true, status: true } });
    const stale = existing.filter((s) => (s.status === 'OPEN' || s.status === 'BLOCKED') && !wantedKeys.has(key(s))).map((s) => s.id);
    const have = new Set(existing.map(key));
    const missing = wanted.filter((s) => !have.has(key(s)));
    await this.prisma.$transaction([
      // Conditional: a slot held a moment ago stays. A slot with past (cancelled) appointments is
      // kept for their history, but no longer offered.
      this.prisma.appointmentSlot.deleteMany({ where: { id: { in: stale }, status: { in: ['OPEN', 'BLOCKED'] }, appointments: { none: {} } } }),
      this.prisma.appointmentSlot.updateMany({ where: { id: { in: stale }, status: 'OPEN', appointments: { some: {} } }, data: { status: 'BLOCKED' } }),
      this.prisma.appointmentSlot.createMany({
        data: missing.map((s) => ({ doctorId, startAt: s.startAt, endAt: s.endAt, appointmentType: s.appointmentType, providerLocationId: s.providerLocationId, status: 'OPEN' as const })),
        skipDuplicates: true,
      }),
    ]);
    if (stale.length > 0 || missing.length > 0) await this.outbox.write(doctorEvent(DoctorEventType.DoctorAvailabilityChanged, { doctorId }));
    return { created: missing.length, removed: stale.length };
  }

  /** Every listed doctor with rules, for the daily horizon job; also prunes past unbooked slots. */
  async regenerateAll(now = new Date()): Promise<number> {
    const doctors = await this.prisma.doctorProfile.findMany({ where: { deletedAt: null, status: 'ACTIVE', availabilityRules: { some: {} } }, select: { id: true } });
    for (const d of doctors) await this.regenerate(d.id, now);
    await this.prisma.appointmentSlot.deleteMany({ where: { startAt: { lt: new Date(now.getTime() - DAY_MS) }, status: { in: ['OPEN', 'BLOCKED'] }, appointments: { none: {} } } });
    return doctors.length;
  }

  // --- Helpers ------------------------------------------------------------------------------

  private async ownDoctor(userId: string) {
    const doctor = await this.prisma.doctorProfile.findFirst({ where: { userId, deletedAt: null } });
    if (!doctor) throw DoctorErrors.notFound();
    return doctor;
  }

  private range(from?: string, to?: string): { from: Date; to: Date } {
    const start = from ? localInstant(from, '00:00') : new Date();
    const end = to ? new Date(localInstant(to, '00:00').getTime() + DAY_MS) : new Date(start.getTime() + 14 * DAY_MS);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) throw ApiException.validation('Give a valid date range.', { fields: ['from', 'to'] });
    if (end.getTime() - start.getTime() > MAX_RANGE_DAYS * DAY_MS) throw ApiException.validation(`A range is at most ${MAX_RANGE_DAYS} days.`, { fields: ['from', 'to'] });
    return { from: start, to: end };
  }

  private async validate(doctor: { id: string; acceptsTelemedicine: boolean }, form: RuleForm): Promise<Omit<Prisma.AvailabilityRuleUncheckedCreateInput, 'doctorId'>> {
    const isBlock = form.type === 'EXCEPTION_BLOCK';
    if (form.type === 'RECURRING' && (form.weekday === undefined || form.weekday === null)) throw ApiException.validation('A weekly pattern needs its day.', { field: 'weekday' });
    if (form.type !== 'RECURRING' && !form.fromDate) throw ApiException.validation('An exception needs its date.', { field: 'fromDate' });
    if (form.type !== 'RECURRING' && form.toDate) throw ApiException.validation('An exception is one day; leave the end date out.', { field: 'toDate' });
    const hasTimes = !!form.startTime && !!form.endTime;
    if (!isBlock && !hasTimes) throw ApiException.validation('Give the start and end time.', { fields: ['startTime', 'endTime'] });
    if ((form.startTime && !form.endTime) || (!form.startTime && form.endTime)) throw ApiException.validation('Give both times, or neither to block the whole day.', { fields: ['startTime', 'endTime'] });
    if (hasTimes && minutes(form.endTime as string) <= minutes(form.startTime as string)) throw ApiException.validation('The end time must be after the start time.', { field: 'endTime' });
    const length = form.slotDurationMinutes ?? 30;
    if (!isBlock && hasTimes && minutes(form.endTime as string) - minutes(form.startTime as string) < length) {
      throw ApiException.validation('The time is shorter than one appointment.', { field: 'slotDurationMinutes' });
    }
    if (form.fromDate && form.toDate && form.toDate < form.fromDate) throw ApiException.validation('The end date is before the start date.', { field: 'toDate' });
    if (!isBlock && form.appointmentType !== 'IN_PERSON' && !doctor.acceptsTelemedicine) {
      throw ApiException.businessRule('Turn on telemedicine in your profile before offering video appointments.', { code: 'TELEMEDICINE_NOT_OFFERED' });
    }
    if (form.providerLocationId) {
      const location = await this.facilities.locationOf(form.providerLocationId);
      const affiliated = location ? await this.prisma.doctorAffiliation.count({ where: { doctorId: doctor.id, providerId: location.providerId } }) : 0;
      if (!location || affiliated === 0) throw ApiException.notFound('Location not found at a facility you practise at.');
    }
    if (!isBlock && form.appointmentType === 'IN_PERSON' && !form.providerLocationId) {
      throw ApiException.validation('An in-person time needs the location where you see patients.', { field: 'providerLocationId' });
    }
    return {
      type: form.type,
      weekday: form.type === 'RECURRING' ? form.weekday : null,
      startTime: form.startTime ?? null,
      endTime: form.endTime ?? null,
      validFrom: form.fromDate ? localInstant(form.fromDate, '00:00') : null,
      validTo: form.toDate ? localInstant(form.toDate, '00:00') : null,
      slotDurationMinutes: isBlock ? null : length,
      bufferMinutes: isBlock ? 0 : (form.bufferMinutes ?? 0),
      appointmentType: form.appointmentType,
      providerLocationId: isBlock ? null : (form.providerLocationId ?? null),
    };
  }
}
