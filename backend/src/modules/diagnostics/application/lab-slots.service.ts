import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../../shared/audit/audit.service';
import { ApiException } from '../../../shared/errors/api-exception';
import { ErrorCode } from '../../../shared/errors/error-codes';
import { PrismaService } from '../../../shared/prisma/prisma.service';
import { PROVIDER_FACILITY_PORT, type IProviderFacilityPort } from '../../provider-directory/application/ports/inbound/provider-facility.port';
import { dates, localInstant, weekdayOf } from '../../doctors/domain/slot-generation';
import { LAB_PROVIDER_TYPES, LabPolicy } from '../domain/diagnostics-rules';

const DAY_MS = 24 * 60 * 60 * 1000;
const minutes = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

export interface SlotBatch {
  locationId: string;
  /** `YYYY-MM-DD` local, inclusive. */
  fromDate: string;
  toDate: string;
  /** 0 = Sunday … 6 = Saturday. */
  weekdays: number[];
  /** `HH:MM` local. */
  startTime: string;
  endTime: string;
  intervalMinutes: number;
  /** How many patients each time takes (a lab runs tests in parallel). */
  capacity: number;
}

/**
 * Work 172: a lab's at-centre capacity slots (module-11 §5.3, §7). A lab creates them in batches
 * — dates, weekdays, hours, interval and how many patients each takes — at one of its locations,
 * in Ethiopian local time. A slot is unique per location and start; creating the same times again
 * changes nothing. Booking takes one place with a single conditional update
 * (`bookedCount < capacity`), and the database refuses more bookings than capacity.
 */
@Injectable()
export class LabSlotsService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(PROVIDER_FACILITY_PORT) private readonly facilities: IProviderFacilityPort,
    private readonly audit: AuditService,
  ) {}

  /** The caller's lab, refused for hospitals and clinics and when suspended (for changes). */
  async callerLab(userId: string, forChange = true) {
    const facility = await this.facilities.callerFacility(userId);
    if (!facility) throw new ApiException(ErrorCode.PROVIDER_NOT_FOUND, 'Healthcare provider not found.');
    if (!LAB_PROVIDER_TYPES.includes(facility.type)) throw ApiException.businessRule('Only laboratories and diagnostic centres take lab bookings.', { code: 'NOT_A_LAB' });
    if (forChange && facility.status === 'SUSPENDED') throw new ApiException(ErrorCode.PROVIDER_SUSPENDED, 'This healthcare provider is suspended and cannot be changed.');
    return facility;
  }

  async createSlots(userId: string, batch: SlotBatch) {
    const lab = await this.callerLab(userId);
    const location = await this.facilities.locationOf(batch.locationId);
    if (!location || location.providerId !== lab.providerId) throw ApiException.notFound('Location not found.');
    if (batch.toDate < batch.fromDate) throw ApiException.validation('The last day is before the first day.', { field: 'toDate' });
    const span = (Date.parse(`${batch.toDate}T00:00:00Z`) - Date.parse(`${batch.fromDate}T00:00:00Z`)) / DAY_MS + 1;
    if (span > LabPolicy.MAX_SLOT_DAYS) throw ApiException.validation(`Create at most ${LabPolicy.MAX_SLOT_DAYS} days at once.`, { field: 'toDate' });
    if (minutes(batch.endTime) <= minutes(batch.startTime)) throw ApiException.validation('The end time must be after the start time.', { field: 'endTime' });
    const now = new Date();
    if (localInstant(batch.toDate, batch.endTime) <= now) throw ApiException.validation('These times are all in the past.', { field: 'toDate' });

    const data: Array<{ providerId: string; locationId: string; startAt: Date; endAt: Date; capacity: number }> = [];
    const weekdays = new Set(batch.weekdays);
    for (const date of dates(localInstant(batch.fromDate, '12:00'), span)) {
      if (!weekdays.has(weekdayOf(date))) continue;
      for (let m = minutes(batch.startTime); m + batch.intervalMinutes <= minutes(batch.endTime); m += batch.intervalMinutes) {
        const hhmm = `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
        const startAt = localInstant(date, hhmm);
        if (startAt <= now) continue;
        data.push({ providerId: lab.providerId, locationId: location.locationId, startAt, endAt: new Date(startAt.getTime() + batch.intervalMinutes * 60_000), capacity: batch.capacity });
      }
    }
    if (data.length > LabPolicy.MAX_SLOTS_PER_REQUEST) throw ApiException.validation(`That makes ${data.length} times; create at most ${LabPolicy.MAX_SLOTS_PER_REQUEST} at once.`, { field: 'intervalMinutes' });
    const { count } = await this.prisma.diagnosticSlot.createMany({ data, skipDuplicates: true });
    await this.audit.record({ actorUserId: userId, action: 'LAB_SLOTS_CREATED', resourceType: 'HealthcareProvider', resourceId: lab.providerId, context: { locationId: location.locationId, created: count, asked: data.length } });
    return { created: count, alreadyThere: data.length - count };
  }

  async labSlots(userId: string, input: { from?: Date; to?: Date; locationId?: string }) {
    const lab = await this.callerLab(userId, false);
    const from = input.from ?? new Date(Date.now() - DAY_MS);
    const to = input.to ?? new Date(from.getTime() + 14 * DAY_MS);
    this.checkRange(from, to);
    const rows = await this.prisma.diagnosticSlot.findMany({
      where: { providerId: lab.providerId, startAt: { gte: from, lt: to }, ...(input.locationId ? { locationId: input.locationId } : {}) },
      orderBy: [{ startAt: 'asc' }, { locationId: 'asc' }],
      take: 2000,
    });
    return rows.map((s) => ({ slotId: s.id, locationId: s.locationId, startAt: s.startAt, endAt: s.endAt, capacity: s.capacity, bookedCount: s.bookedCount, status: s.status }));
  }

  /** Block or open a future slot; blocking keeps its bookings, only stops new ones. */
  async setBlocked(userId: string, slotId: string, blocked: boolean) {
    const lab = await this.callerLab(userId);
    const slot = await this.prisma.diagnosticSlot.findFirst({ where: { id: slotId, providerId: lab.providerId } });
    if (!slot) throw ApiException.notFound('Slot not found.');
    if (slot.startAt <= new Date()) throw ApiException.conflict('A past time cannot be changed.');
    const status = blocked ? 'BLOCKED' : slot.bookedCount >= slot.capacity ? 'FULL' : 'OPEN';
    await this.prisma.diagnosticSlot.update({ where: { id: slot.id }, data: { status } });
    await this.audit.record({ actorUserId: userId, action: blocked ? 'LAB_SLOT_BLOCKED' : 'LAB_SLOT_UNBLOCKED', resourceType: 'DiagnosticSlot', resourceId: slot.id, context: { providerId: lab.providerId } });
    return { slotId: slot.id, status };
  }

  /** Remove an empty future slot. */
  async remove(userId: string, slotId: string) {
    const lab = await this.callerLab(userId);
    const deleted = await this.prisma.diagnosticSlot.deleteMany({ where: { id: slotId, providerId: lab.providerId, bookedCount: 0, startAt: { gt: new Date() } } });
    if (deleted.count !== 1) {
      const exists = await this.prisma.diagnosticSlot.findFirst({ where: { id: slotId, providerId: lab.providerId }, select: { id: true } });
      if (!exists) throw ApiException.notFound('Slot not found.');
      throw ApiException.conflict('Only an empty future time can be removed; block it instead.');
    }
    return { removed: true };
  }

  /** What a patient can book at an eligible lab: OPEN future slots with places left. */
  async openSlots(providerId: string, input: { from?: Date; to?: Date; locationId?: string }) {
    const [lab] = await this.facilities.summaries([providerId]);
    if (!lab?.eligible || !LAB_PROVIDER_TYPES.includes(lab.type)) throw new ApiException(ErrorCode.PROVIDER_NOT_FOUND, 'Healthcare provider not found.');
    const now = new Date();
    const from = input.from && input.from > now ? input.from : now;
    const to = input.to ?? new Date(from.getTime() + 14 * DAY_MS);
    this.checkRange(from, to);
    const rows = await this.prisma.diagnosticSlot.findMany({
      where: { providerId, status: 'OPEN', startAt: { gte: new Date(Math.max(from.getTime(), now.getTime() + LabPolicy.MIN_LEAD_MINUTES * 60_000)), lt: to }, ...(input.locationId ? { locationId: input.locationId } : {}) },
      orderBy: { startAt: 'asc' },
      take: 1000,
    });
    const names = new Map<string, string>();
    for (const id of new Set(rows.map((r) => r.locationId))) names.set(id, (await this.facilities.locationOf(id))?.name ?? '');
    return rows
      .filter((s) => s.bookedCount < s.capacity && names.get(s.locationId))
      .map((s) => ({ slotId: s.id, startAt: s.startAt, endAt: s.endAt, placesLeft: s.capacity - s.bookedCount, location: { locationId: s.locationId, name: names.get(s.locationId) as string } }));
  }

  private checkRange(from: Date, to: Date) {
    if (to <= from) throw ApiException.validation('Give a valid date range.', { fields: ['from', 'to'] });
    if (to.getTime() - from.getTime() > 31 * DAY_MS + DAY_MS) throw ApiException.validation('A range is at most 31 days.', { fields: ['from', 'to'] });
  }
}
