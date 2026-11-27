import request from 'supertest';
import { randomUUID } from 'crypto';
import { localDate, weekdayOf } from '../../src/modules/doctors/domain/slot-generation';
import { auth, body, createUserWithRole, errorOf } from '../support/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';
import { registeredProvider } from '../provider-directory/support';
import { registeredDoctor } from './support';

const MIN = 60_000;
const DAY = 24 * 60 * MIN;

/** The first Monday at least two days ahead, as a local `YYYY-MM-DD` date. */
function nextMonday(): string {
  let date = localDate(new Date(Date.now() + 2 * DAY));
  while (weekdayOf(date) !== 1) date = localDate(new Date(Date.parse(`${date}T12:00:00Z`) + DAY));
  return date;
}

/**
 * Work 168: booking doctors. One active appointment per slot (a conditional update and a partial
 * unique index), confirmed at once with the fee paid at the visit; cancel and reschedule up to 2
 * hours before; doctors check in, complete, mark no-shows and cancel; facilities see theirs; the
 * patient and the doctor are notified.
 */
describe('Doctors — booking appointments (Work 168, e2e)', () => {
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
    patch: (path: string, payload: object) => request(ctx.server).patch(path).set(...auth(token)).send(payload),
  });

  /** A cardiologist with Monday 09:00–11:00 in person at a hospital, fee ETB 500. */
  async function bookableDoctor() {
    const d = await registeredDoctor(ctx);
    const p = await registeredProvider(ctx, { admin: d.platformAdmin });
    const locationId = body(await as(p.token).post('/provider/locations', { name: 'Main campus', city: 'Addis Ababa', lat: 9.0206, lng: 38.7469 }).expect(201)).locationId as string;
    await as(p.token).post('/provider/doctors', { identifier: d.person.email }).expect(201);
    await as(d.token).patch('/doctor/profile', { consultationFeeInPerson: 50000 }).expect(200);
    await as(d.token).post('/doctor/availability', { type: 'RECURRING', weekday: 1, startTime: '09:00', endTime: '11:00', appointmentType: 'IN_PERSON', providerLocationId: locationId }).expect(201);
    const monday = nextMonday();
    const slots = (body(await request(ctx.server).get(`/doctors/${d.doctorId}/slots?from=${monday}&to=${monday}`).expect(200)).items as Array<{ slotId: string }>).map((s) => s.slotId);
    return { ...d, provider: p, locationId, slots };
  }

  const appointmentOf = (id: string) => ctx.prisma.appointment.findUniqueOrThrow({ where: { id } });
  const slotOf = (id: string) => ctx.prisma.appointmentSlot.findUniqueOrThrow({ where: { id } });

  it('a patient books a time: confirmed at once, the fee to pay at the visit; both are notified', async () => {
    const d = await bookableDoctor();
    const patient = await createUserWithRole(ctx, 'CUSTOMER');
    const booked = body(await as(patient.accessToken).post('/appointments', { slotId: d.slots[0], reasonNote: 'Chest pain on exertion' }).expect(201));
    expect(booked).toMatchObject({
      status: 'CONFIRMED',
      appointmentType: 'IN_PERSON',
      fee: 50000,
      currency: 'ETB',
      payAt: 'VISIT',
      canChange: true,
      reasonNote: 'Chest pain on exertion',
      doctor: { doctorId: d.doctorId, fullName: 'Dr. Selamawit Bekele', specialty: 'Cardiology' },
      location: expect.objectContaining({ locationId: d.locationId, name: 'Main campus', providerName: 'Tikur Anbessa Hospital' }),
    });
    expect((await slotOf(d.slots[0])).status).toBe('BOOKED');
    const open = (body(await request(ctx.server).get(`/doctors/${d.doctorId}/slots`).expect(200)).items as Array<{ slotId: string }>).map((s) => s.slotId);
    expect(open).not.toContain(d.slots[0]);

    // The same request again returns the same appointment.
    expect(body(await as(patient.accessToken).post('/appointments', { slotId: d.slots[0] }).expect(201)).appointmentId).toBe(booked.appointmentId);
    expect(body(await as(patient.accessToken).get('/appointments').expect(200)).items).toHaveLength(1);

    await ctx.drainOutbox();
    const notes = await ctx.prisma.notification.findMany({ where: { templateCode: 'APPOINTMENT_BOOKED', channel: 'IN_APP' }, select: { recipientUserId: true, renderedBody: true } });
    expect(notes.map((n) => n.recipientUserId).sort()).toEqual([patient.userId, d.person.userId].sort());
    expect(notes.find((n) => n.recipientUserId === patient.userId)?.renderedBody).toMatch(/Dr\. Selamawit Bekele, Mon .*09:00\. The fee is paid at the visit\./);

    // The doctor and the facility see it, with how to reach the patient.
    const doctorView = body(await as(d.token).get('/doctor/appointments').expect(200)).items as Array<Record<string, unknown>>;
    expect(doctorView).toEqual([expect.objectContaining({ appointmentId: booked.appointmentId, status: 'CONFIRMED', patient: expect.objectContaining({ userId: patient.userId }) })]);
    expect((body(await as(d.provider.token).get('/provider/appointments').expect(200)).items as unknown[]).length).toBe(1);
  });

  it('two patients racing for one time: exactly one gets it', async () => {
    const d = await bookableDoctor();
    const a = await createUserWithRole(ctx, 'CUSTOMER');
    const b = await createUserWithRole(ctx, 'CUSTOMER');
    const results = await Promise.all([a, b].map((p) => as(p.accessToken).post('/appointments', { slotId: d.slots[0] })));
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(errorOf(results.find((r) => r.status === 409)!).code).toBe('SLOT_UNAVAILABLE');
    expect(await ctx.prisma.appointment.count({ where: { slotId: d.slots[0], status: 'CONFIRMED' } })).toBe(1);
  });

  it('cancelling frees the time for someone else; within 2 hours it is refused', async () => {
    const d = await bookableDoctor();
    const a = await createUserWithRole(ctx, 'CUSTOMER');
    const b = await createUserWithRole(ctx, 'CUSTOMER');
    const first = body(await as(a.accessToken).post('/appointments', { slotId: d.slots[0] }).expect(201));
    expect(body(await as(a.accessToken).post(`/appointments/${first.appointmentId}/cancel`, { reason: 'Feeling better' }).expect(200))).toMatchObject({ status: 'CANCELLED', canChange: false });
    expect((await slotOf(d.slots[0])).status).toBe('OPEN');
    await as(a.accessToken).post(`/appointments/${first.appointmentId}/cancel`).expect(409);

    const second = body(await as(b.accessToken).post('/appointments', { slotId: d.slots[0] }).expect(201));
    await ctx.prisma.appointment.update({ where: { id: second.appointmentId as string }, data: { scheduledStart: new Date(Date.now() + 60 * MIN) } });
    const late = await as(b.accessToken).post(`/appointments/${second.appointmentId}/cancel`);
    expect(late.status).toBe(409);
    expect(errorOf(late).code).toBe('CANCELLATION_WINDOW_CLOSED');
    expect(body(await as(a.accessToken).get('/appointments?scope=past').expect(200)).items).toEqual([expect.objectContaining({ appointmentId: first.appointmentId, status: 'CANCELLED' })]);
    await as(a.accessToken).get(`/appointments/${second.appointmentId}`).expect(404);
  });

  it('rescheduling holds the new time before letting the old one go', async () => {
    const d = await bookableDoctor();
    const patient = await createUserWithRole(ctx, 'CUSTOMER');
    const other = await createUserWithRole(ctx, 'CUSTOMER');
    const booked = body(await as(patient.accessToken).post('/appointments', { slotId: d.slots[0] }).expect(201));
    await as(other.accessToken).post('/appointments', { slotId: d.slots[2] }).expect(201);

    await as(patient.accessToken).post(`/appointments/${booked.appointmentId}/reschedule`, { slotId: d.slots[2] }).expect(409);
    const otherDoctor = await registeredDoctor(ctx, { admin: d.platformAdmin, fullName: 'Dr. Abebe Kebede' });
    const strange = await ctx.prisma.appointmentSlot.create({ data: { doctorId: otherDoctor.doctorId, startAt: new Date(Date.now() + 3 * DAY), endAt: new Date(Date.now() + 3 * DAY + 30 * MIN), appointmentType: 'IN_PERSON' } });
    await as(patient.accessToken).post(`/appointments/${booked.appointmentId}/reschedule`, { slotId: strange.id }).expect(409);

    const moved = body(await as(patient.accessToken).post(`/appointments/${booked.appointmentId}/reschedule`, { slotId: d.slots[1] }).expect(200));
    expect(moved).toMatchObject({ status: 'CONFIRMED', rescheduledFromId: booked.appointmentId, fee: 50000 });
    expect((await appointmentOf(booked.appointmentId as string)).status).toBe('RESCHEDULED');
    expect((await slotOf(d.slots[0])).status).toBe('OPEN');
    expect((await slotOf(d.slots[1])).status).toBe('BOOKED');
    expect((body(await as(patient.accessToken).get('/appointments').expect(200)).items as Array<{ appointmentId: string }>).map((i) => i.appointmentId)).toEqual([moved.appointmentId]);

    await ctx.drainOutbox();
    expect(await ctx.prisma.notification.count({ where: { templateCode: 'APPOINTMENT_RESCHEDULED', channel: 'IN_APP' } })).toBe(2);
  });

  it('the doctor checks in, completes, marks a no-show, and cancels with a reason', async () => {
    const d = await bookableDoctor();
    // One at a time: each sign-up reads its own code.
    const patients = [];
    for (let i = 0; i < 3; i += 1) patients.push(await createUserWithRole(ctx, 'CUSTOMER'));
    const ids = await Promise.all(patients.map(async (p, i) => body(await as(p.accessToken).post('/appointments', { slotId: d.slots[i] }).expect(201)).appointmentId as string));
    const doctor = as(d.token);

    const early = await doctor.post(`/doctor/appointments/${ids[0]}/check-in`);
    expect(early.status).toBe(422);
    await ctx.prisma.appointment.update({ where: { id: ids[0] }, data: { scheduledStart: new Date(Date.now() - 5 * MIN) } });
    expect(body(await doctor.post(`/doctor/appointments/${ids[0]}/check-in`).expect(200)).status).toBe('CHECKED_IN');
    expect(body(await doctor.post(`/doctor/appointments/${ids[0]}/complete`).expect(200)).status).toBe('COMPLETED');
    await doctor.post(`/doctor/appointments/${ids[0]}/complete`).expect(409);

    await doctor.post(`/doctor/appointments/${ids[1]}/no-show`).expect(422);
    await ctx.prisma.appointment.update({ where: { id: ids[1] }, data: { scheduledStart: new Date(Date.now() - 20 * MIN) } });
    expect(body(await doctor.post(`/doctor/appointments/${ids[1]}/no-show`).expect(200)).status).toBe('NO_SHOW');

    await doctor.post(`/doctor/appointments/${ids[2]}/cancel`, { reason: 'no' }).expect(400);
    expect(body(await doctor.post(`/doctor/appointments/${ids[2]}/cancel`, { reason: 'Called into surgery' }).expect(200))).toMatchObject({ status: 'CANCELLED', cancelReason: 'Called into surgery' });
    expect((await slotOf(d.slots[2])).status).toBe('BLOCKED');
    expect(await ctx.prisma.appointmentStatusHistory.count({ where: { appointmentId: { in: ids } } })).toBe(3 + 2 + 1 + 1);

    await ctx.drainOutbox();
    const cancelled = await ctx.prisma.notification.findFirst({ where: { templateCode: 'APPOINTMENT_CANCELLED', channel: 'IN_APP', recipientUserId: patients[2].userId } });
    expect(cancelled?.renderedBody).toMatch(/Dr\. Selamawit Bekele cancelled your appointment .* Please book another time\./);

    // Another doctor cannot act on these.
    const other = await registeredDoctor(ctx, { admin: d.platformAdmin, fullName: 'Dr. Abebe Kebede' });
    await as(other.token).post(`/doctor/appointments/${ids[2]}/cancel`, { reason: 'Not mine' }).expect(404);
  });

  it('refuses a wrong type, a time too soon, more than five upcoming, and an unlisted doctor', async () => {
    const d = await bookableDoctor();
    const patient = await createUserWithRole(ctx, 'CUSTOMER');
    const typed = await as(patient.accessToken).post('/appointments', { slotId: d.slots[0], appointmentType: 'TELEMEDICINE' });
    expect(typed.status).toBe(409);
    expect(errorOf(typed).code).toBe('SLOT_UNAVAILABLE');

    const soon = await ctx.prisma.appointmentSlot.create({ data: { doctorId: d.doctorId, startAt: new Date(Date.now() + 10 * MIN), endAt: new Date(Date.now() + 40 * MIN), appointmentType: 'IN_PERSON', providerLocationId: d.locationId } });
    await as(patient.accessToken).post('/appointments', { slotId: soon.id }).expect(409);
    await as(patient.accessToken).post('/appointments', { slotId: randomUUID() }).expect(409);

    const monday = nextMonday();
    const later = localDate(new Date(Date.parse(`${monday}T12:00:00Z`) + 7 * DAY));
    const more = (body(await request(ctx.server).get(`/doctors/${d.doctorId}/slots?from=${later}&to=${later}`).expect(200)).items as Array<{ slotId: string }>).map((s) => s.slotId);
    for (const slotId of [...d.slots, more[0]]) await as(patient.accessToken).post('/appointments', { slotId }).expect(201);
    const sixth = await as(patient.accessToken).post('/appointments', { slotId: more[1] });
    expect(sixth.status).toBe(422);

    await as(d.platformAdmin.accessToken).post(`/admin/doctors/${d.doctorId}/suspend`, { reason: 'Complaint under review' }).expect(200);
    const other = await createUserWithRole(ctx, 'CUSTOMER');
    const unlisted = await as(other.accessToken).post('/appointments', { slotId: more[2] });
    expect(unlisted.status).toBe(404);
    expect(errorOf(unlisted).code).toBe('DOCTOR_NOT_FOUND');
    await request(ctx.server).post('/appointments').send({ slotId: more[2] }).expect(401);
  });
});
