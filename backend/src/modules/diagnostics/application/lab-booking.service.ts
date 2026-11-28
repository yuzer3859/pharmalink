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
import { ACTIVE_BOOKING_STATUSES, bookingNumber, LAB_PROVIDER_TYPES, LabErrors, labEvent, LabEventType, labelOf, LabPolicy } from '../domain/diagnostics-rules';
import { LabSlotsService } from './lab-slots.service';

type Tx = Prisma.TransactionClient;
type BookingRow = Prisma.DiagnosticBookingGetPayload<{ include: { items: true } }>;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export interface BookLabInput {
  providerId: string;
  serviceIds: string[];
  slotId: string;
  /** The patient confirms they read the preparation (BRULE-36). */
  prepAcknowledged?: boolean;
  notes?: string;
}

/**
 * Work 172: booking lab tests at a centre (module-11 §8.1, §11). One booking holds one or more of
 * a lab's available services at one capacity slot; a place is taken with a single conditional
 * update (`bookedCount < capacity`, backed by a CHECK constraint), so a slot is never overbooked.
 * Tests with preparation instructions need the patient's acknowledgement (BRULE-36). There is no
 * online payment yet (as for doctors, 2026-11-27): the booking is CONFIRMED, prices are
 * snapshotted, and the patient pays at the centre. A patient cancels up to 2 hours before; the
 * place is given back. Status history, audit and `diagnostics.booking.*` events on every change.
 */
@Injectable()
export class LabBookingService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(PROVIDER_FACILITY_PORT) private readonly facilities: IProviderFacilityPort,
    @Inject(IDENTITY_ORGANIZATION_READ_PORT) private readonly accounts: IIdentityOrganizationReadPort,
    private readonly slots: LabSlotsService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  async book(patientUserId: string, input: BookLabInput) {
    const serviceIds = [...new Set(input.serviceIds)];
    if (serviceIds.length === 0 || serviceIds.length > LabPolicy.MAX_ITEMS) throw ApiException.validation(`Choose 1 to ${LabPolicy.MAX_ITEMS} tests.`, { field: 'serviceIds' });
    const [lab] = await this.facilities.summaries([input.providerId]);
    if (!lab?.eligible || !LAB_PROVIDER_TYPES.includes(lab.type)) throw new ApiException(ErrorCode.PROVIDER_NOT_FOUND, 'Healthcare provider not found.');

    const services = await this.facilities.servicesOf(input.providerId, serviceIds);
    const missing = serviceIds.filter((id) => !services.some((s) => s.serviceId === id && s.isAvailable));
    if (missing.length > 0) throw ApiException.notFound('A chosen test is not offered by this lab now.', { serviceIds: missing });

    const slot = await this.prisma.diagnosticSlot.findFirst({ where: { id: input.slotId, providerId: input.providerId } });
    if (!slot) throw LabErrors.slotUnavailable('NOT_FOUND');
    const elsewhere = services.filter((s) => s.locationId && s.locationId !== slot.locationId);
    if (elsewhere.length > 0) throw LabErrors.slotUnavailable('LOCATION');
    if (slot.startAt.getTime() < Date.now() + LabPolicy.MIN_LEAD_MINUTES * MINUTE) throw LabErrors.slotUnavailable('TOO_SOON');

    const needPrep = services.filter((s) => s.preparationInstructions?.trim());
    if (needPrep.length > 0 && input.prepAcknowledged !== true) throw LabErrors.prepNotAcknowledged(needPrep.map((s) => s.name));

    const upcoming = await this.prisma.diagnosticBooking.count({ where: { patientUserId, status: { in: [...ACTIVE_BOOKING_STATUSES] }, scheduledAt: { gt: new Date() } } });
    if (upcoming >= LabPolicy.MAX_UPCOMING) throw ApiException.businessRule(`You can hold up to ${LabPolicy.MAX_UPCOMING} upcoming lab bookings.`, { code: 'TOO_MANY_BOOKINGS' });

    const bookingId = await this.prisma.$transaction(async (tx) => {
      // The anti-overbooking guarantee: one place is taken only while one is left.
      const taken = await tx.$executeRaw`
        UPDATE "diagnostic_slots"
        SET "bookedCount" = "bookedCount" + 1,
            "status" = CASE WHEN "bookedCount" + 1 >= "capacity" THEN 'FULL'::"DiagnosticSlotStatus" ELSE "status" END
        WHERE "id" = ${slot.id} AND "status" = 'OPEN' AND "bookedCount" < "capacity" AND "startAt" > now()`;
      if (taken !== 1) throw LabErrors.slotUnavailable('FULL');
      const created = await tx.diagnosticBooking.create({
        data: {
          bookingNumber: bookingNumber(),
          patientUserId,
          providerId: input.providerId,
          locationId: slot.locationId,
          fulfillmentMode: 'AT_CENTER',
          status: 'CONFIRMED',
          prepAcknowledgedAt: needPrep.length > 0 ? new Date() : null,
          totalPrice: services.reduce((sum, s) => sum + (s.price ?? 0), 0),
          currency: services[0]?.currency ?? 'ETB',
          scheduledAt: slot.startAt,
          slotId: slot.id,
          notes: input.notes?.trim() || null,
          items: {
            create: services.map((s) => ({
              serviceOfferingId: s.serviceId,
              price: s.price ?? 0,
              serviceSnapshot: { name: s.name, type: s.type, code: s.code, price: s.price, currency: s.currency, preparationInstructions: s.preparationInstructions } as Prisma.InputJsonValue,
            })),
          },
        },
        select: { id: true, bookingNumber: true },
      });
      await this.history(tx, created.id, null, 'CONFIRMED', 'PATIENT', patientUserId, null);
      await this.audit.record({ actorUserId: patientUserId, action: 'LAB_BOOKED', resourceType: 'DiagnosticBooking', resourceId: created.id, context: { providerId: input.providerId, slotId: slot.id, tests: services.length } }, tx);
      await this.announce(tx, LabEventType.Booked, created.id, created.bookingNumber, lab, patientUserId, services.length, slot.startAt, 'PATIENT');
      return created.id;
    });
    return this.patientView(patientUserId, bookingId);
  }

  async myBookings(patientUserId: string, scope: 'upcoming' | 'past') {
    // Upcoming: still active, and either not long past its time or with a sample in the lab.
    const upcoming: Prisma.DiagnosticBookingWhereInput = {
      status: { in: [...ACTIVE_BOOKING_STATUSES] },
      OR: [{ scheduledAt: { gt: new Date(Date.now() - 12 * HOUR) } }, { status: { in: ['SAMPLE_COLLECTED', 'PROCESSING'] } }],
    };
    const rows = await this.prisma.diagnosticBooking.findMany({
      where: scope === 'upcoming' ? { patientUserId, ...upcoming } : { patientUserId, NOT: upcoming },
      include: { items: true },
      orderBy: { scheduledAt: scope === 'upcoming' ? 'asc' : 'desc' },
      take: 50,
    });
    return Promise.all(rows.map((r) => this.toPatientView(r)));
  }

  async patientView(patientUserId: string, bookingId: string) {
    const row = await this.prisma.diagnosticBooking.findFirst({ where: { id: bookingId, patientUserId }, include: { items: true } });
    if (!row) throw LabErrors.notFound();
    return this.toPatientView(row);
  }

  async cancelByPatient(patientUserId: string, bookingId: string, reason?: string) {
    const row = await this.prisma.diagnosticBooking.findFirst({ where: { id: bookingId, patientUserId }, include: { items: true } });
    if (!row) throw LabErrors.notFound();
    if (row.status !== 'CONFIRMED') throw new ApiException(ErrorCode.INVALID_APPOINTMENT_STATE, `A ${row.status.toLowerCase().replace(/_/g, ' ')} lab booking cannot be cancelled.`, { status: row.status });
    if (!row.scheduledAt || row.scheduledAt.getTime() - Date.now() < LabPolicy.CANCEL_CUTOFF_HOURS * HOUR) throw LabErrors.cancelClosed();
    const [lab] = await this.facilities.summaries([row.providerId]);
    await this.prisma.$transaction(async (tx) => {
      const updated = await tx.diagnosticBooking.updateMany({ where: { id: row.id, status: 'CONFIRMED' }, data: { status: 'CANCELLED', cancelReason: reason?.trim() || null } });
      if (updated.count !== 1) throw new ApiException(ErrorCode.INVALID_APPOINTMENT_STATE, 'This lab booking changed just now.');
      await tx.bookingItem.updateMany({ where: { bookingId: row.id }, data: { itemStatus: 'CANCELLED' } });
      if (row.slotId) await this.givePlaceBack(tx, row.slotId);
      await this.history(tx, row.id, 'CONFIRMED', 'CANCELLED', 'PATIENT', patientUserId, reason?.trim() || null);
      await this.audit.record({ actorUserId: patientUserId, action: 'LAB_BOOKING_CANCELLED', resourceType: 'DiagnosticBooking', resourceId: row.id, context: { by: 'PATIENT' } }, tx);
      await this.announce(tx, LabEventType.Cancelled, row.id, row.bookingNumber, lab, row.patientUserId, row.items.length, row.scheduledAt, 'PATIENT');
    });
    return this.patientView(patientUserId, bookingId);
  }

  /** A lab's bookings, from yesterday for 14 days by default, with how to reach the patient. */
  async labBookings(userId: string, input: { from?: Date; to?: Date; status?: string }) {
    const lab = await this.slots.callerLab(userId, false);
    const from = input.from ?? new Date(Date.now() - DAY);
    const to = input.to ?? new Date(from.getTime() + 14 * DAY);
    if (to <= from || to.getTime() - from.getTime() > 32 * DAY) throw ApiException.validation('A range is at most 31 days.', { fields: ['from', 'to'] });
    const rows = await this.prisma.diagnosticBooking.findMany({
      where: { providerId: lab.providerId, scheduledAt: { gte: from, lt: to }, ...(input.status ? { status: input.status as never } : {}) },
      include: { items: true },
      orderBy: { scheduledAt: 'asc' },
      take: 1000,
    });
    const people = await this.accounts.accountsById([...new Set(rows.map((r) => r.patientUserId))]);
    return rows.map((r) => {
      const p = people.find((x) => x.userId === r.patientUserId);
      return { ...this.base(r), patient: { userId: r.patientUserId, email: p?.email ?? null, phone: p?.phone ?? null }, notes: r.notes };
    });
  }

  // --- Helpers ------------------------------------------------------------------------------

  private async givePlaceBack(tx: Tx, slotId: string) {
    await tx.$executeRaw`
      UPDATE "diagnostic_slots"
      SET "bookedCount" = GREATEST("bookedCount" - 1, 0),
          "status" = CASE WHEN "status" = 'FULL' THEN 'OPEN'::"DiagnosticSlotStatus" ELSE "status" END
      WHERE "id" = ${slotId}`;
  }

  private history(tx: Tx, bookingId: string, from: string | null, to: string, actorType: string, actorId: string, reason: string | null) {
    return tx.diagnosticStatusHistory.create({ data: { bookingId, fromStatus: from, toStatus: to, actorType, actorId, reason } });
  }

  private async announce(
    tx: Tx,
    type: (typeof LabEventType)[keyof typeof LabEventType],
    bookingId: string,
    number: string,
    lab: { providerId: string; displayName: string } | undefined,
    patientUserId: string,
    testCount: number,
    scheduledAt: Date | null,
    by: 'PATIENT' | 'LAB',
  ) {
    await this.outbox.write(
      labEvent(type, {
        bookingId,
        bookingNumber: number,
        providerId: lab?.providerId ?? '',
        patientUserId,
        recipientUserIds: [patientUserId],
        providerName: lab?.displayName ?? '',
        testCount,
        scheduledAt: scheduledAt?.toISOString() ?? null,
        scheduledLabel: labelOf(scheduledAt),
        by,
      }),
      tx as never,
    );
  }

  private base(r: BookingRow) {
    return {
      bookingId: r.id,
      bookingNumber: r.bookingNumber,
      status: r.status,
      fulfillmentMode: r.fulfillmentMode,
      scheduledAt: r.scheduledAt,
      totalPrice: r.totalPrice,
      currency: r.currency,
      prepAcknowledgedAt: r.prepAcknowledgedAt,
      cancelReason: r.cancelReason,
      items: r.items.map((i) => {
        const snap = (i.serviceSnapshot ?? {}) as Record<string, unknown>;
        return {
          itemId: i.id,
          serviceId: i.serviceOfferingId,
          name: typeof snap.name === 'string' ? snap.name : '',
          type: typeof snap.type === 'string' ? snap.type : null,
          price: typeof snap.price === 'number' ? snap.price : null,
          preparationInstructions: typeof snap.preparationInstructions === 'string' ? snap.preparationInstructions : null,
          status: i.itemStatus,
        };
      }),
    };
  }

  private async toPatientView(r: BookingRow) {
    const [lab] = await this.facilities.summaries([r.providerId]);
    const location = r.locationId ? await this.facilities.locationOf(r.locationId) : null;
    return {
      ...this.base(r),
      provider: { providerId: r.providerId, name: lab?.displayName ?? '', type: lab?.type ?? null },
      location: location ? { locationId: location.locationId, name: location.name, city: location.city, lat: location.lat, lng: location.lng } : null,
      notes: r.notes,
      canCancel: r.status === 'CONFIRMED' && !!r.scheduledAt && r.scheduledAt.getTime() - Date.now() >= LabPolicy.CANCEL_CUTOFF_HOURS * HOUR,
      payAt: 'CENTER' as const,
    };
  }
}
