import { randomUUID } from 'crypto';
import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuditService } from '../../../shared/audit/audit.service';
import { ApiException } from '../../../shared/errors/api-exception';
import { ErrorCode } from '../../../shared/errors/error-codes';
import { OutboxService } from '../../../shared/outbox/outbox.service';
import { PrismaService } from '../../../shared/prisma/prisma.service';
import {
  ALLOWED_DOCUMENT_CONTENT_TYPES,
  DOCUMENT_STORAGE_PORT,
  documentRef,
  MAX_DOCUMENT_BYTES,
  parseDocumentRef,
  PREVIEW_URL_TTL_SECONDS,
  UPLOAD_URL_TTL_SECONDS,
  type IDocumentStoragePort,
} from '../../../shared/storage/document-storage.port';
import { LabErrors, labEvent, LabEventType, labelOf } from '../domain/diagnostics-rules';
import { LabSlotsService } from './lab-slots.service';

type Tx = Prisma.TransactionClient;
type BookingRow = Prisma.DiagnosticBookingGetPayload<{ include: { items: true } }>;
type LabAction = 'check-in' | 'collect' | 'processing' | 'no-show' | 'cancel' | 'reject-sample';

const MINUTE = 60_000;
const NAMESPACE = 'lab-result';

export interface AnalyteInput {
  name: string;
  value?: string;
  unit?: string;
  referenceRange?: string;
  flag?: 'NORMAL' | 'HIGH' | 'LOW' | 'CRITICAL';
}

const TRANSITIONS: Record<LabAction, { from: string[]; to: string }> = {
  'check-in': { from: ['CONFIRMED'], to: 'CHECKED_IN' },
  collect: { from: ['CONFIRMED', 'CHECKED_IN'], to: 'SAMPLE_COLLECTED' },
  processing: { from: ['SAMPLE_COLLECTED'], to: 'PROCESSING' },
  'no-show': { from: ['CONFIRMED'], to: 'NO_SHOW' },
  cancel: { from: ['CONFIRMED'], to: 'CANCELLED' },
  'reject-sample': { from: ['SAMPLE_COLLECTED', 'PROCESSING'], to: 'SAMPLE_REJECTED' },
};

/**
 * Work 173: the lab's day and the results (module-11 §5.3, §8.2, BRULE-37).
 *
 * The lab moves a booking through check-in, sample collected and processing (or no-show, a
 * rejected sample, or its own cancellation with a reason). It issues each test's result — a file
 * uploaded straight to document storage and/or structured values — as an immutable version; a
 * correction is a new version that marks the previous one AMENDED and points back to it, never an
 * overwrite. When every test has a result the booking is RESULT_READY and the patient is told.
 *
 * A patient (or the lab) opens a result file only through a 5-minute signed link, and every link
 * issued is written to `result_access_log` and the audit log. The API never returns file bytes.
 */
@Injectable()
export class LabResultsService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(DOCUMENT_STORAGE_PORT) private readonly storage: IDocumentStoragePort,
    private readonly slots: LabSlotsService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  // --- The lab's workflow -------------------------------------------------------------------

  async labAction(userId: string, bookingId: string, action: LabAction, reason?: string) {
    const { lab, booking } = await this.labBooking(userId, bookingId);
    const rule = TRANSITIONS[action];
    if (!rule.from.includes(booking.status)) {
      throw new ApiException(ErrorCode.INVALID_APPOINTMENT_STATE, `A ${booking.status.toLowerCase().replace(/_/g, ' ')} lab booking cannot be changed that way.`, { status: booking.status, action });
    }
    const start = booking.scheduledAt?.getTime() ?? 0;
    const why = reason?.trim() ?? '';
    if ((action === 'cancel' || action === 'reject-sample') && (why.length < 3 || why.length > 500)) throw ApiException.validation('Give a reason of 3 to 500 characters.', { field: 'reason' });
    if (action === 'check-in' && Date.now() < start - 60 * MINUTE) throw ApiException.businessRule('A patient can be checked in from an hour before the booking.', { code: 'TOO_EARLY' });
    if (action === 'no-show' && Date.now() < start) throw ApiException.businessRule('A no-show is marked after the booking was due to start.', { code: 'TOO_EARLY' });
    if (action === 'cancel' && Date.now() >= start) throw ApiException.businessRule('A booking that has started cannot be cancelled.', { code: 'STARTED' });

    await this.prisma.$transaction(async (tx) => {
      const updated = await tx.diagnosticBooking.updateMany({
        where: { id: booking.id, status: booking.status },
        data: { status: rule.to as never, ...(action === 'cancel' ? { cancelReason: why } : {}) },
      });
      if (updated.count !== 1) throw new ApiException(ErrorCode.INVALID_APPOINTMENT_STATE, 'This lab booking changed just now.');
      if (action === 'collect') await tx.bookingItem.updateMany({ where: { bookingId: booking.id, itemStatus: 'PENDING' }, data: { itemStatus: 'COLLECTED' } });
      if (action === 'processing') await tx.bookingItem.updateMany({ where: { bookingId: booking.id, itemStatus: 'COLLECTED' }, data: { itemStatus: 'PROCESSING' } });
      if (action === 'cancel') {
        await tx.bookingItem.updateMany({ where: { bookingId: booking.id }, data: { itemStatus: 'CANCELLED' } });
        if (booking.slotId) {
          await tx.$executeRaw`
            UPDATE "diagnostic_slots"
            SET "bookedCount" = GREATEST("bookedCount" - 1, 0),
                "status" = CASE WHEN "status" = 'FULL' THEN 'OPEN'::"DiagnosticSlotStatus" ELSE "status" END
            WHERE "id" = ${booking.slotId}`;
        }
      }
      await tx.diagnosticStatusHistory.create({ data: { bookingId: booking.id, fromStatus: booking.status, toStatus: rule.to, actorType: 'LAB', actorId: userId, reason: why || null } });
      await this.audit.record({ actorUserId: userId, action: `LAB_BOOKING_${rule.to}`, resourceType: 'DiagnosticBooking', resourceId: booking.id, context: { from: booking.status, ...(why ? { reason: why } : {}) } }, tx);
      if (action === 'cancel') await this.announce(tx, LabEventType.Cancelled, booking, lab.displayName, 'LAB', null);
      if (action === 'reject-sample') await this.announce(tx, LabEventType.SampleRejected, booking, lab.displayName, 'LAB', why);
    });
    return this.labView(booking.id);
  }

  /** A signed upload for one result file, stored under the booking. */
  async requestResultUpload(userId: string, bookingId: string, itemId: string, contentType: string, bytes: number) {
    const { booking } = await this.labBooking(userId, bookingId);
    if (!booking.items.some((i) => i.id === itemId)) throw ApiException.notFound('Test not found in this booking.');
    if (!(ALLOWED_DOCUMENT_CONTENT_TYPES as readonly string[]).includes(contentType)) throw ApiException.validation(`A result file must be one of ${ALLOWED_DOCUMENT_CONTENT_TYPES.join(', ')}.`, { field: 'contentType' });
    if (!Number.isInteger(bytes) || bytes < 1 || bytes > MAX_DOCUMENT_BYTES) throw ApiException.validation('A result file must be up to 10 MB.', { field: 'bytes' });
    if (!this.storage.available) throw new ApiException(ErrorCode.DEPENDENCY_UNAVAILABLE, 'File uploads are not available.');
    const storageRef = documentRef(NAMESPACE, booking.id, randomUUID());
    const upload = await this.storage.signUpload(parseDocumentRef(storageRef)!, contentType, bytes, UPLOAD_URL_TTL_SECONDS);
    await this.audit.record({ actorUserId: userId, action: 'LAB_RESULT_UPLOAD_ISSUED', resourceType: 'DiagnosticBooking', resourceId: booking.id, context: { itemId, contentType, bytes } });
    return { storageRef, upload };
  }

  /** Issue (or correct) one test's result: a file, values, or both. */
  async issueResult(userId: string, bookingId: string, itemId: string, input: { storageRef?: string; analytes?: AnalyteInput[] }) {
    const { lab, booking } = await this.labBooking(userId, bookingId);
    const item = booking.items.find((i) => i.id === itemId);
    if (!item) throw ApiException.notFound('Test not found in this booking.');
    if (!['SAMPLE_COLLECTED', 'PROCESSING', 'RESULT_READY'].includes(booking.status)) {
      throw new ApiException(ErrorCode.INVALID_APPOINTMENT_STATE, 'Results are issued once the sample is collected.', { status: booking.status });
    }
    if (item.itemStatus === 'CANCELLED') throw new ApiException(ErrorCode.INVALID_APPOINTMENT_STATE, 'This test was cancelled.');
    const analytes = input.analytes ?? [];
    if (!input.storageRef && analytes.length === 0) throw ApiException.validation('Attach the result file or enter the values.', { fields: ['storageRef', 'analytes'] });
    if (input.storageRef) {
      const ref = parseDocumentRef(input.storageRef);
      if (!ref || ref.namespace !== NAMESPACE || ref.ownerId !== booking.id) throw ApiException.validation('The file must be uploaded for this booking.', { field: 'storageRef' });
      if (!(await this.storage.describe(ref))) throw new ApiException(ErrorCode.DOCUMENT_NOT_STORED, 'The result file has not been uploaded yet.');
    }

    const previous = await this.prisma.diagnosticResult.findFirst({ where: { bookingItemId: item.id }, orderBy: { version: 'desc' } });
    const name = this.nameOf(item);
    const outcome = await this.prisma.$transaction(async (tx) => {
      if (previous) {
        const superseded = await tx.diagnosticResult.updateMany({ where: { id: previous.id, status: 'READY' }, data: { status: 'AMENDED' } });
        if (superseded.count !== 1) throw new ApiException(ErrorCode.INVALID_APPOINTMENT_STATE, 'This result changed just now.');
      }
      const result = await tx.diagnosticResult.create({
        data: {
          bookingItemId: item.id,
          version: (previous?.version ?? 0) + 1,
          status: 'READY',
          supersedesId: previous?.id ?? null,
          fileRef: input.storageRef ?? null,
          issuedByUserId: userId,
          issuedAt: new Date(),
          analytes: { create: analytes.map((a) => ({ analyteName: a.name.trim(), value: a.value?.trim() || null, unit: a.unit?.trim() || null, referenceRange: a.referenceRange?.trim() || null, flag: a.flag ?? null })) },
        },
        select: { id: true, version: true },
      });
      await tx.bookingItem.update({ where: { id: item.id }, data: { itemStatus: 'RESULT_READY', resultId: result.id } });
      const pending = await tx.bookingItem.count({ where: { bookingId: booking.id, itemStatus: { notIn: ['RESULT_READY', 'CANCELLED'] } } });
      const allReady = pending === 0 && booking.status !== 'RESULT_READY';
      if (allReady) {
        await tx.diagnosticBooking.update({ where: { id: booking.id }, data: { status: 'RESULT_READY' } });
        await tx.diagnosticStatusHistory.create({ data: { bookingId: booking.id, fromStatus: booking.status, toStatus: 'RESULT_READY', actorType: 'LAB', actorId: userId, reason: null } });
      }
      await this.audit.record({ actorUserId: userId, action: previous ? 'LAB_RESULT_AMENDED' : 'LAB_RESULT_ISSUED', resourceType: 'DiagnosticResult', resourceId: result.id, context: { bookingId: booking.id, itemId: item.id, version: result.version, hasFile: !!input.storageRef, analytes: analytes.length } }, tx);
      if (allReady) await this.announce(tx, LabEventType.ResultReady, booking, lab.displayName, 'LAB', null);
      else if (previous && booking.status === 'RESULT_READY') await this.announce(tx, LabEventType.ResultAmended, booking, lab.displayName, 'LAB', name);
      return result;
    });
    return { resultId: outcome.id, version: outcome.version, booking: await this.labView(booking.id) };
  }

  /** The lab's view of one booking, with every result version. */
  async labBookingDetail(userId: string, bookingId: string) {
    await this.labBooking(userId, bookingId);
    return this.labView(bookingId);
  }

  // --- Patients -----------------------------------------------------------------------------

  /** The patient's current results (the latest version of each test). */
  async patientResults(patientUserId: string, bookingId: string) {
    const booking = await this.prisma.diagnosticBooking.findFirst({ where: { id: bookingId, patientUserId }, include: { items: true } });
    if (!booking) throw LabErrors.notFound();
    const results = await this.prisma.diagnosticResult.findMany({ where: { bookingItemId: { in: booking.items.map((i) => i.id) }, status: 'READY' }, include: { analytes: true } });
    return {
      bookingId: booking.id,
      bookingNumber: booking.bookingNumber,
      status: booking.status,
      items: booking.items.map((i) => {
        const r = results.find((x) => x.bookingItemId === i.id);
        return {
          itemId: i.id,
          name: this.nameOf(i),
          status: i.itemStatus,
          result: r
            ? {
                resultId: r.id,
                version: r.version,
                corrected: r.version > 1,
                issuedAt: r.issuedAt,
                hasFile: !!r.fileRef,
                analytes: r.analytes.map((a) => ({ name: a.analyteName, value: a.value, unit: a.unit, referenceRange: a.referenceRange, flag: a.flag })),
              }
            : null,
        };
      }),
    };
  }

  /** A 5-minute link to a result file, for the patient; every link is logged. */
  async patientResultLink(patientUserId: string, bookingId: string, resultId: string, ip: string | null) {
    const booking = await this.prisma.diagnosticBooking.findFirst({ where: { id: bookingId, patientUserId }, include: { items: true } });
    if (!booking) throw LabErrors.notFound();
    return this.link(patientUserId, 'PATIENT', booking, resultId, ip);
  }

  /** The lab opens a result file it issued, logged the same way. */
  async labResultLink(userId: string, bookingId: string, resultId: string, ip: string | null) {
    const { booking } = await this.labBooking(userId, bookingId);
    return this.link(userId, 'LAB', booking, resultId, ip);
  }

  // --- Helpers ------------------------------------------------------------------------------

  private async link(actorUserId: string, role: 'PATIENT' | 'LAB', booking: BookingRow, resultId: string, ip: string | null) {
    const result = await this.prisma.diagnosticResult.findFirst({ where: { id: resultId, bookingItemId: { in: booking.items.map((i) => i.id) } } });
    if (!result) throw ApiException.notFound('Result not found.');
    if (role === 'PATIENT' && result.status !== 'READY') throw ApiException.notFound('Result not found.');
    if (!result.fileRef) throw ApiException.notFound('This result has no file.');
    const ref = parseDocumentRef(result.fileRef)!;
    const info = await this.storage.describe(ref);
    if (!info) throw new ApiException(ErrorCode.DOCUMENT_NOT_STORED, 'The result file is not available.');
    const signed = await this.storage.signRead(ref, info.contentType, PREVIEW_URL_TTL_SECONDS);
    await this.prisma.resultAccessLog.create({ data: { resultId: result.id, actorUserId, role, accessType: 'VIEW', outcome: 'ALLOW' } });
    await this.audit.record({ actorUserId, action: 'LAB_RESULT_OPENED', resourceType: 'DiagnosticResult', resourceId: result.id, context: { bookingId: booking.id, role, version: result.version }, ip });
    return { url: signed.url, expiresAt: signed.expiresAt, contentType: info.contentType };
  }

  private async labBooking(userId: string, bookingId: string) {
    const lab = await this.slots.callerLab(userId, false);
    const booking = await this.prisma.diagnosticBooking.findFirst({ where: { id: bookingId, providerId: lab.providerId }, include: { items: true } });
    if (!booking) throw LabErrors.notFound();
    return { lab, booking };
  }

  private nameOf(item: { serviceSnapshot: Prisma.JsonValue }): string {
    const snap = (item.serviceSnapshot ?? {}) as Record<string, unknown>;
    return typeof snap.name === 'string' ? snap.name : '';
  }

  private async labView(bookingId: string) {
    const booking = await this.prisma.diagnosticBooking.findUniqueOrThrow({ where: { id: bookingId }, include: { items: true } });
    const results = await this.prisma.diagnosticResult.findMany({ where: { bookingItemId: { in: booking.items.map((i) => i.id) } }, include: { analytes: true }, orderBy: { version: 'asc' } });
    return {
      bookingId: booking.id,
      bookingNumber: booking.bookingNumber,
      status: booking.status,
      scheduledAt: booking.scheduledAt,
      cancelReason: booking.cancelReason,
      items: booking.items.map((i) => ({
        itemId: i.id,
        name: this.nameOf(i),
        status: i.itemStatus,
        results: results
          .filter((r) => r.bookingItemId === i.id)
          .map((r) => ({ resultId: r.id, version: r.version, status: r.status, issuedAt: r.issuedAt, hasFile: !!r.fileRef, analytes: r.analytes.map((a) => ({ name: a.analyteName, value: a.value, unit: a.unit, referenceRange: a.referenceRange, flag: a.flag })) })),
      })),
    };
  }

  private async announce(tx: Tx, type: (typeof LabEventType)[keyof typeof LabEventType], booking: BookingRow, providerName: string, by: 'PATIENT' | 'LAB', detail: string | null) {
    await this.outbox.write(
      labEvent(type, {
        bookingId: booking.id,
        bookingNumber: booking.bookingNumber,
        providerId: booking.providerId,
        patientUserId: booking.patientUserId,
        recipientUserIds: [booking.patientUserId],
        providerName,
        testCount: booking.items.length,
        scheduledAt: booking.scheduledAt?.toISOString() ?? null,
        scheduledLabel: labelOf(booking.scheduledAt),
        by,
        detail,
      }),
      tx as never,
    );
  }
}
