import request from 'supertest';
import { randomUUID } from 'crypto';
import { localDate } from '../../src/modules/doctors/domain/slot-generation';
import { auth, body, createUserWithRole, errorOf } from '../support/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';
import { registeredProvider } from '../provider-directory/support';

const DAY = 24 * 60 * 60 * 1000;
const PDF = Buffer.from('%PDF-1.4\n% PharmaLink test lab result\n%%EOF\n');

/**
 * Work 173: the lab's day — check-in, sample collected, processing — and results: a file and/or
 * values per test, issued as immutable versions (a correction is a new version, the old one
 * AMENDED); the booking is RESULT_READY when every test has one; patients open result files only
 * through logged 5-minute links; a rejected sample or a lab cancellation tells the patient.
 */
describe('Diagnostics — the lab workflow and results (Work 173, e2e)', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  beforeEach(async () => {
    await ctx.reset();
  });

  const as = (token: string) => ({
    get: (path: string) => request(ctx.server).get(path).set(...auth(token)),
    post: (path: string, payload: object = {}) => request(ctx.server).post(path).set(...auth(token)).send(payload),
  });

  /** A lab, a patient and a confirmed booking of two tests, moved to start in a few minutes. */
  async function booked() {
    const lab = await registeredProvider(ctx, { type: 'LAB', displayName: 'Bethel Medical Laboratory' });
    const portal = as(lab.token);
    const locationId = body(await portal.post('/provider/locations', { name: 'Bole branch', city: 'Addis Ababa', lat: 9.0108, lng: 38.7613 }).expect(201)).locationId as string;
    const cbc = body(await portal.post('/provider/services', { type: 'LAB_TEST', name: 'Complete blood count', price: 25000 }).expect(201)).serviceId as string;
    const lipid = body(await portal.post('/provider/services', { type: 'LAB_TEST', name: 'Lipid profile', price: 40000 }).expect(201)).serviceId as string;
    const day = localDate(new Date(Date.now() + 2 * DAY));
    await portal.post('/provider/diagnostics/slots', { locationId, fromDate: day, toDate: day, weekdays: [0, 1, 2, 3, 4, 5, 6], startTime: '09:00', endTime: '10:00', intervalMinutes: 30, capacity: 2 }).expect(201);
    const [slot] = body(await request(ctx.server).get(`/diagnostics/providers/${lab.providerId}/slots`).expect(200)).items as Array<{ slotId: string }>;
    const patient = await createUserWithRole(ctx, 'CUSTOMER');
    const booking = body(await as(patient.accessToken).post('/diagnostics/bookings', { providerId: lab.providerId, serviceIds: [cbc, lipid], slotId: slot.slotId }).expect(201));
    const items = booking.items as Array<{ itemId: string; name: string }>;
    const item = (name: string) => items.find((i) => i.name === name)!.itemId;
    return { lab, portal, patient, me: as(patient.accessToken), bookingId: booking.bookingId as string, slotId: slot.slotId, cbcItem: item('Complete blood count'), lipidItem: item('Lipid profile') };
  }

  const startSoon = (bookingId: string) => ctx.prisma.diagnosticBooking.update({ where: { id: bookingId }, data: { scheduledAt: new Date(Date.now() - 5 * 60_000) } });

  async function resultFile(portal: ReturnType<typeof as>, bookingId: string, itemId: string): Promise<string> {
    const issued = body(await portal.post(`/provider/diagnostics/bookings/${bookingId}/items/${itemId}/result/uploads`, { contentType: 'application/pdf', bytes: PDF.length }).expect(201)) as {
      storageRef: string;
      upload: { url: string };
    };
    await request(ctx.server).put(new URL(issued.upload.url).pathname).set('Content-Type', 'application/pdf').send(PDF).expect(200);
    return issued.storageRef;
  }

  it('moves a booking through check-in, sample collected and processing', async () => {
    const b = await booked();
    const early = await b.portal.post(`/provider/diagnostics/bookings/${b.bookingId}/check-in`);
    expect(early.status).toBe(422);
    await startSoon(b.bookingId);
    expect(body(await b.portal.post(`/provider/diagnostics/bookings/${b.bookingId}/check-in`).expect(200)).status).toBe('CHECKED_IN');
    await b.portal.post(`/provider/diagnostics/bookings/${b.bookingId}/check-in`).expect(409);
    const collected = body(await b.portal.post(`/provider/diagnostics/bookings/${b.bookingId}/collect`).expect(200));
    expect(collected).toMatchObject({ status: 'SAMPLE_COLLECTED' });
    expect((collected.items as Array<{ status: string }>).every((i) => i.status === 'COLLECTED')).toBe(true);
    expect(body(await b.portal.post(`/provider/diagnostics/bookings/${b.bookingId}/processing`).expect(200)).status).toBe('PROCESSING');
    expect(await ctx.prisma.diagnosticStatusHistory.count({ where: { bookingId: b.bookingId } })).toBe(4);
  });

  it('issues results per test; the booking is ready when all are in; the patient opens files through logged links', async () => {
    const b = await booked();
    await startSoon(b.bookingId);
    await b.portal.post(`/provider/diagnostics/bookings/${b.bookingId}/items/${b.cbcItem}/result`, { analytes: [{ name: 'Haemoglobin', value: '13.5' }] }).expect(409);
    await b.portal.post(`/provider/diagnostics/bookings/${b.bookingId}/collect`).expect(200);

    await b.portal.post(`/provider/diagnostics/bookings/${b.bookingId}/items/${b.cbcItem}/result`, {}).expect(400);
    const ref = await resultFile(b.portal, b.bookingId, b.cbcItem);
    const first = body(
      await b.portal
        .post(`/provider/diagnostics/bookings/${b.bookingId}/items/${b.cbcItem}/result`, { storageRef: ref, analytes: [{ name: 'Haemoglobin', value: '13.5', unit: 'g/dL', referenceRange: '12–16', flag: 'NORMAL' }] })
        .expect(201),
    );
    expect(first).toMatchObject({ version: 1, booking: { status: 'SAMPLE_COLLECTED' } });
    const done = body(await b.portal.post(`/provider/diagnostics/bookings/${b.bookingId}/items/${b.lipidItem}/result`, { analytes: [{ name: 'LDL', value: '160', unit: 'mg/dL', flag: 'HIGH' }] }).expect(201));
    expect(done).toMatchObject({ booking: { status: 'RESULT_READY' } });

    await ctx.drainOutbox();
    expect(await ctx.prisma.notification.count({ where: { templateCode: 'LAB_RESULT_READY', channel: 'IN_APP', recipientUserId: b.patient.userId } })).toBe(1);

    const results = body(await b.me.get(`/diagnostics/bookings/${b.bookingId}/results`).expect(200));
    const items = results.items as Array<{ itemId: string; result: Record<string, unknown> | null }>;
    expect(items.find((i) => i.itemId === b.cbcItem)?.result).toMatchObject({ version: 1, corrected: false, hasFile: true, analytes: [{ name: 'Haemoglobin', value: '13.5', unit: 'g/dL', referenceRange: '12–16', flag: 'NORMAL' }] });
    expect(items.find((i) => i.itemId === b.lipidItem)?.result).toMatchObject({ hasFile: false, analytes: [expect.objectContaining({ name: 'LDL', flag: 'HIGH' })] });

    const link = body(await b.me.post(`/diagnostics/bookings/${b.bookingId}/results/${first.resultId}/link`).expect(200));
    expect(link).toMatchObject({ contentType: 'application/pdf' });
    expect(typeof link.url).toBe('string');
    expect(await ctx.prisma.resultAccessLog.count({ where: { resultId: first.resultId as string, actorUserId: b.patient.userId, role: 'PATIENT', accessType: 'VIEW', outcome: 'ALLOW' } })).toBe(1);
    expect(await ctx.prisma.auditLog.count({ where: { action: 'LAB_RESULT_OPENED', resourceId: first.resultId as string } })).toBe(1);
    const lipidResult = items.find((i) => i.itemId === b.lipidItem)!.result!.resultId as string;
    await b.me.post(`/diagnostics/bookings/${b.bookingId}/results/${lipidResult}/link`).expect(404);

    // Another patient sees nothing of it.
    const stranger = await createUserWithRole(ctx, 'CUSTOMER');
    await as(stranger.accessToken).get(`/diagnostics/bookings/${b.bookingId}/results`).expect(404);
    await as(stranger.accessToken).post(`/diagnostics/bookings/${b.bookingId}/results/${first.resultId}/link`).expect(404);
  });

  it('a correction is a new version; the old one is kept as AMENDED and no longer shown to the patient', async () => {
    const b = await booked();
    await startSoon(b.bookingId);
    await b.portal.post(`/provider/diagnostics/bookings/${b.bookingId}/collect`).expect(200);
    const v1 = body(await b.portal.post(`/provider/diagnostics/bookings/${b.bookingId}/items/${b.cbcItem}/result`, { storageRef: await resultFile(b.portal, b.bookingId, b.cbcItem) }).expect(201));
    await b.portal.post(`/provider/diagnostics/bookings/${b.bookingId}/items/${b.lipidItem}/result`, { analytes: [{ name: 'LDL', value: '160' }] }).expect(201);
    const v2 = body(await b.portal.post(`/provider/diagnostics/bookings/${b.bookingId}/items/${b.cbcItem}/result`, { analytes: [{ name: 'Haemoglobin', value: '11.2', flag: 'LOW' }] }).expect(201));
    expect(v2.version).toBe(2);
    expect(await ctx.prisma.diagnosticResult.findUniqueOrThrow({ where: { id: v1.resultId as string } })).toMatchObject({ status: 'AMENDED' });
    expect(await ctx.prisma.diagnosticResult.findUniqueOrThrow({ where: { id: v2.resultId as string } })).toMatchObject({ status: 'READY', supersedesId: v1.resultId });

    const cbc = (body(await b.me.get(`/diagnostics/bookings/${b.bookingId}/results`).expect(200)).items as Array<{ itemId: string; result: Record<string, unknown> }>).find((i) => i.itemId === b.cbcItem)!;
    expect(cbc.result).toMatchObject({ resultId: v2.resultId, version: 2, corrected: true, hasFile: false });
    await b.me.post(`/diagnostics/bookings/${b.bookingId}/results/${v1.resultId}/link`).expect(404);
    // The lab still opens the original, logged.
    await b.portal.post(`/provider/diagnostics/bookings/${b.bookingId}/results/${v1.resultId}/link`).expect(200);
    expect(await ctx.prisma.resultAccessLog.count({ where: { resultId: v1.resultId as string, role: 'LAB' } })).toBe(1);

    const labView = body(await b.portal.get(`/provider/diagnostics/bookings/${b.bookingId}`).expect(200));
    expect((labView.items as Array<{ itemId: string; results: Array<{ version: number; status: string }> }>).find((i) => i.itemId === b.cbcItem)!.results.map((r) => [r.version, r.status])).toEqual([
      [1, 'AMENDED'],
      [2, 'READY'],
    ]);
    await ctx.drainOutbox();
    expect(await ctx.prisma.notification.count({ where: { templateCode: 'LAB_RESULT_AMENDED', channel: 'IN_APP' } })).toBe(1);
  });

  it('checks result files: uploaded, and for this booking', async () => {
    const b = await booked();
    const other = await booked();
    await startSoon(b.bookingId);
    await b.portal.post(`/provider/diagnostics/bookings/${b.bookingId}/collect`).expect(200);
    const notUploaded = body(await b.portal.post(`/provider/diagnostics/bookings/${b.bookingId}/items/${b.cbcItem}/result/uploads`, { contentType: 'application/pdf', bytes: PDF.length }).expect(201)).storageRef as string;
    const missing = await b.portal.post(`/provider/diagnostics/bookings/${b.bookingId}/items/${b.cbcItem}/result`, { storageRef: notUploaded });
    expect(missing.status).toBe(409);
    const foreign = await resultFile(other.portal, other.bookingId, other.cbcItem);
    await b.portal.post(`/provider/diagnostics/bookings/${b.bookingId}/items/${b.cbcItem}/result`, { storageRef: foreign }).expect(400);
    await b.portal.post(`/provider/diagnostics/bookings/${b.bookingId}/items/${b.cbcItem}/result/uploads`, { contentType: 'text/html', bytes: 10 }).expect(400);
    // Another lab cannot reach this booking.
    await other.portal.get(`/provider/diagnostics/bookings/${b.bookingId}`).expect(404);
    await other.portal.post(`/provider/diagnostics/bookings/${b.bookingId}/items/${b.cbcItem}/result`, { analytes: [{ name: 'X' }] }).expect(404);
  });

  it('a rejected sample and a lab cancellation tell the patient; a cancellation gives the place back', async () => {
    const b = await booked();
    await b.portal.post(`/provider/diagnostics/bookings/${b.bookingId}/cancel`, { reason: 'no' }).expect(400);
    const cancelled = body(await b.portal.post(`/provider/diagnostics/bookings/${b.bookingId}/cancel`, { reason: 'Analyser out of service' }).expect(200));
    expect(cancelled).toMatchObject({ status: 'CANCELLED', cancelReason: 'Analyser out of service' });
    expect(await ctx.prisma.diagnosticSlot.findUniqueOrThrow({ where: { id: b.slotId } })).toMatchObject({ bookedCount: 0 });

    const c = await booked();
    await startSoon(c.bookingId);
    await c.portal.post(`/provider/diagnostics/bookings/${c.bookingId}/collect`).expect(200);
    const rejected = await c.portal.post(`/provider/diagnostics/bookings/${c.bookingId}/reject-sample`, { reason: 'Sample haemolysed' });
    expect(body(rejected).status).toBe('SAMPLE_REJECTED');
    await ctx.drainOutbox();
    const note = await ctx.prisma.notification.findFirst({ where: { templateCode: 'LAB_SAMPLE_REJECTED', channel: 'IN_APP', recipientUserId: c.patient.userId } });
    expect(note?.renderedBody).toMatch(/Sample haemolysed\. Please book again\./);
    expect(await ctx.prisma.notification.count({ where: { templateCode: 'LAB_CANCELLED', channel: 'IN_APP', recipientUserId: b.patient.userId } })).toBe(1);

    const late = await c.portal.post(`/provider/diagnostics/bookings/${c.bookingId}/no-show`);
    expect(errorOf(late).code).toBe('INVALID_APPOINTMENT_STATE');
    await c.portal.get(`/provider/diagnostics/bookings/${randomUUID()}`).expect(404);
  });
});
