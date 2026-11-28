import request from 'supertest';
import { randomUUID } from 'crypto';
import { localDate } from '../../src/modules/doctors/domain/slot-generation';
import { auth, body, createUserWithRole, errorOf } from '../support/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';
import { registeredProvider } from '../provider-directory/support';

const DAY = 24 * 60 * 60 * 1000;
const dayAhead = (n: number) => localDate(new Date(Date.now() + n * DAY));

/**
 * Work 172: Module 11 begins. A lab creates capacity slots; patients book one or more tests at a
 * slot, acknowledging preparation; a slot never takes more patients than its capacity; patients
 * cancel up to 2 hours before; the lab sees its bookings; the patient is notified.
 */
describe('Diagnostics — booking lab tests at a centre (Work 172, e2e)', () => {
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
    del: (path: string) => request(ctx.server).delete(path).set(...auth(token)),
  });

  /** A lab in Bole with two tests (one needs fasting) and 09:00–10:00 slots of 2 places for a week. */
  async function labWithSlots() {
    const lab = await registeredProvider(ctx, { type: 'LAB', displayName: 'Bethel Medical Laboratory' });
    const portal = as(lab.token);
    const locationId = body(await portal.post('/provider/locations', { name: 'Bole branch', city: 'Addis Ababa', lat: 9.0108, lng: 38.7613 }).expect(201)).locationId as string;
    const cbc = body(await portal.post('/provider/services', { type: 'LAB_TEST', name: 'Complete blood count', price: 25000 }).expect(201)).serviceId as string;
    const fbs = body(await portal.post('/provider/services', { type: 'LAB_TEST', name: 'Fasting blood sugar', price: 15000, preparationInstructions: 'Fast for 8 hours.' }).expect(201)).serviceId as string;
    const batch = { locationId, fromDate: dayAhead(2), toDate: dayAhead(8), weekdays: [0, 1, 2, 3, 4, 5, 6], startTime: '09:00', endTime: '10:00', intervalMinutes: 30, capacity: 2 };
    const created = body(await portal.post('/provider/diagnostics/slots', batch).expect(201));
    const open = body(await request(ctx.server).get(`/diagnostics/providers/${lab.providerId}/slots`).expect(200)).items as Array<{ slotId: string; placesLeft: number }>;
    return { lab, portal, locationId, cbc, fbs, batch, created, open };
  }

  it('a lab creates capacity slots once; patients see them with the places left', async () => {
    const { lab, portal, batch, created, open } = await labWithSlots();
    expect(created).toEqual({ created: 14, alreadyThere: 0 });
    expect(body(await portal.post('/provider/diagnostics/slots', batch).expect(201))).toEqual({ created: 0, alreadyThere: 14 });
    expect(open.length).toBe(14);
    expect(open[0]).toEqual(expect.objectContaining({ placesLeft: 2, location: expect.objectContaining({ name: 'Bole branch' }) }));
    expect((body(await portal.get('/provider/diagnostics/slots').expect(200)).items as unknown[]).length).toBe(14);

    await portal.post('/provider/diagnostics/slots', { ...batch, toDate: dayAhead(90) }).expect(400);
    await portal.post('/provider/diagnostics/slots', { ...batch, locationId: randomUUID() }).expect(404);
    await portal.post('/provider/diagnostics/slots', { ...batch, capacity: 0 }).expect(400);
    const hospital = await registeredProvider(ctx, { admin: lab.platformAdmin });
    const hosp = as(hospital.token);
    const hospLocation = body(await hosp.post('/provider/locations', { name: 'Main', city: 'Addis Ababa', lat: 9.02, lng: 38.74 }).expect(201)).locationId as string;
    expect((await hosp.post('/provider/diagnostics/slots', { ...batch, locationId: hospLocation })).status).toBe(422);
    await request(ctx.server).get(`/diagnostics/providers/${hospital.providerId}/slots`).expect(404);
  });

  it('books tests at a slot: preparation must be acknowledged; confirmed, paid at the centre; the patient is told', async () => {
    const { lab, portal, cbc, fbs, open } = await labWithSlots();
    const patient = await createUserWithRole(ctx, 'CUSTOMER');
    const me = as(patient.accessToken);
    const form = { providerId: lab.providerId, serviceIds: [cbc, fbs], slotId: open[0].slotId };

    const unacked = await me.post('/diagnostics/bookings', form);
    expect(unacked.status).toBe(422);
    expect(errorOf(unacked).code).toBe('PREP_NOT_ACKNOWLEDGED');

    const booked = body(await me.post('/diagnostics/bookings', { ...form, prepAcknowledged: true, notes: 'Morning please' }).expect(201));
    expect(booked).toMatchObject({
      status: 'CONFIRMED',
      fulfillmentMode: 'AT_CENTER',
      totalPrice: 40000,
      currency: 'ETB',
      payAt: 'CENTER',
      canCancel: true,
      provider: { providerId: lab.providerId, name: 'Bethel Medical Laboratory' },
      location: expect.objectContaining({ name: 'Bole branch' }),
    });
    expect(booked.bookingNumber).toMatch(/^LAB-\d{6}-\d{6}$/);
    expect((booked.items as Array<{ name: string }>).map((i) => i.name).sort()).toEqual(['Complete blood count', 'Fasting blood sugar']);
    expect(booked.prepAcknowledgedAt).toBeTruthy();
    expect(body(await me.get('/diagnostics/bookings').expect(200)).items).toHaveLength(1);

    const labView = body(await portal.get('/provider/diagnostics/bookings').expect(200)).items as Array<Record<string, unknown>>;
    expect(labView).toEqual([expect.objectContaining({ bookingId: booked.bookingId, notes: 'Morning please', patient: expect.objectContaining({ userId: patient.userId }) })]);

    await ctx.drainOutbox();
    const note = await ctx.prisma.notification.findFirst({ where: { templateCode: 'LAB_BOOKED', channel: 'IN_APP', recipientUserId: patient.userId } });
    expect(note?.renderedBody).toMatch(/Bethel Medical Laboratory, .*09:00\. Booking LAB-/);
  });

  it('a slot never takes more patients than its capacity, and a cancellation gives the place back', async () => {
    const { lab, cbc, open } = await labWithSlots();
    const slotId = open[0].slotId;
    const patients = [];
    for (let i = 0; i < 3; i += 1) patients.push(await createUserWithRole(ctx, 'CUSTOMER'));
    const first = body(await as(patients[0].accessToken).post('/diagnostics/bookings', { providerId: lab.providerId, serviceIds: [cbc], slotId }).expect(201));
    const race = await Promise.all(patients.slice(1).map((p) => as(p.accessToken).post('/diagnostics/bookings', { providerId: lab.providerId, serviceIds: [cbc], slotId })));
    expect(race.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await ctx.prisma.diagnosticSlot.findUniqueOrThrow({ where: { id: slotId } })).toMatchObject({ bookedCount: 2, status: 'FULL' });
    const visible = (body(await request(ctx.server).get(`/diagnostics/providers/${lab.providerId}/slots`).expect(200)).items as Array<{ slotId: string }>).map((s) => s.slotId);
    expect(visible).not.toContain(slotId);

    expect(body(await as(patients[0].accessToken).post(`/diagnostics/bookings/${first.bookingId}/cancel`, { reason: 'Travelling' }).expect(200))).toMatchObject({ status: 'CANCELLED', canCancel: false });
    expect(await ctx.prisma.diagnosticSlot.findUniqueOrThrow({ where: { id: slotId } })).toMatchObject({ bookedCount: 1, status: 'OPEN' });
    await as(patients[0].accessToken).post(`/diagnostics/bookings/${first.bookingId}/cancel`).expect(409);
    expect(body(await as(patients[0].accessToken).get('/diagnostics/bookings?scope=past').expect(200)).items).toEqual([expect.objectContaining({ bookingId: first.bookingId, status: 'CANCELLED' })]);

    // Within 2 hours of the start, cancelling is refused.
    const second = await ctx.prisma.diagnosticBooking.findFirstOrThrow({ where: { slotId, status: 'CONFIRMED' } });
    await ctx.prisma.diagnosticBooking.update({ where: { id: second.id }, data: { scheduledAt: new Date(Date.now() + 60 * 60_000) } });
    const owner = patients.find((p) => p.userId === second.patientUserId)!;
    const late = await as(owner.accessToken).post(`/diagnostics/bookings/${second.id}/cancel`);
    expect(late.status).toBe(409);
    expect(errorOf(late).code).toBe('CANCELLATION_WINDOW_CLOSED');
  });

  it('the lab blocks, opens and removes times', async () => {
    const { lab, portal, cbc, open } = await labWithSlots();
    const [a, b] = open;
    expect(body(await portal.post(`/provider/diagnostics/slots/${a.slotId}/block`).expect(200)).status).toBe('BLOCKED');
    const visible = (body(await request(ctx.server).get(`/diagnostics/providers/${lab.providerId}/slots`).expect(200)).items as Array<{ slotId: string }>).map((s) => s.slotId);
    expect(visible).not.toContain(a.slotId);
    expect(body(await portal.post(`/provider/diagnostics/slots/${a.slotId}/unblock`).expect(200)).status).toBe('OPEN');

    const patient = await createUserWithRole(ctx, 'CUSTOMER');
    await as(patient.accessToken).post('/diagnostics/bookings', { providerId: lab.providerId, serviceIds: [cbc], slotId: b.slotId }).expect(201);
    await portal.del(`/provider/diagnostics/slots/${b.slotId}`).expect(409);
    expect(body(await portal.del(`/provider/diagnostics/slots/${a.slotId}`).expect(200))).toEqual({ removed: true });
    await portal.del(`/provider/diagnostics/slots/${randomUUID()}`).expect(404);
  });

  it('refuses tests not offered, another lab’s slot, and anyone without the permission', async () => {
    const { lab, portal, cbc, open } = await labWithSlots();
    const other = await labWithSlots();
    const patient = await createUserWithRole(ctx, 'CUSTOMER');
    const me = as(patient.accessToken);

    await me.post('/diagnostics/bookings', { providerId: lab.providerId, serviceIds: [other.cbc], slotId: open[0].slotId }).expect(404);
    await me.post('/diagnostics/bookings', { providerId: lab.providerId, serviceIds: [cbc], slotId: other.open[0].slotId }).expect(409);
    await request(ctx.server).patch(`/provider/services/${cbc}`).set(...auth(lab.token)).send({ isAvailable: false }).expect(200);
    await me.post('/diagnostics/bookings', { providerId: lab.providerId, serviceIds: [cbc], slotId: open[0].slotId }).expect(404);

    await as(patient.accessToken).get('/provider/diagnostics/bookings').expect(403);
    await request(ctx.server).post('/diagnostics/bookings').send({ providerId: lab.providerId, serviceIds: [cbc], slotId: open[0].slotId }).expect(401);
    expect(await ctx.prisma.diagnosticBooking.count()).toBe(0);
    void portal;
  });
});
