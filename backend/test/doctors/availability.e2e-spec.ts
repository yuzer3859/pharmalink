import request from 'supertest';
import { randomUUID } from 'crypto';
import { AvailabilityService } from '../../src/modules/doctors/application/availability.service';
import { localDate, localInstant, weekdayOf } from '../../src/modules/doctors/domain/slot-generation';
import { auth, body, errorOf } from '../support/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';
import { registeredProvider } from '../provider-directory/support';
import { registeredDoctor } from './support';

const DAY = 24 * 60 * 60 * 1000;

/** The first Monday at least two days ahead, as a local `YYYY-MM-DD` date. */
function nextMonday(): string {
  let date = localDate(new Date(Date.now() + 2 * DAY));
  while (weekdayOf(date) !== 1) date = localDate(new Date(Date.parse(`${date}T12:00:00Z`) + DAY));
  return date;
}

/**
 * Work 167: doctors set availability (weekly patterns, extra time, time off) at the facilities
 * they practise at; bookable slots are generated for 60 days in Ethiopian local time; patients
 * see open slots; doctors block slots ad hoc; and doctors are searchable, soonest available first.
 */
describe('Doctors — availability, slots and search (Work 167, e2e)', () => {
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
    del: (path: string) => request(ctx.server).delete(path).set(...auth(token)),
  });

  /** A cardiologist practising at a hospital in Addis Ababa, with telemedicine on. */
  async function doctorAtHospital() {
    const d = await registeredDoctor(ctx);
    const p = await registeredProvider(ctx, { admin: d.platformAdmin });
    const locationId = body(await as(p.token).post('/provider/locations', { name: 'Main campus', city: 'Addis Ababa', lat: 9.0206, lng: 38.7469 }).expect(201)).locationId as string;
    await as(p.token).post('/provider/doctors', { identifier: d.person.email }).expect(201);
    await as(d.token).patch('/doctor/profile', { acceptsTelemedicine: true, consultationFeeInPerson: 50000 }).expect(200);
    return { ...d, provider: p, locationId };
  }

  const weekly = (locationId: string) => ({ type: 'RECURRING', weekday: 1, startTime: '09:00', endTime: '11:00', slotDurationMinutes: 30, appointmentType: 'IN_PERSON', providerLocationId: locationId });

  it('checks rules: an in-person time needs one of my locations; video needs telemedicine on', async () => {
    const d = await doctorAtHospital();
    const me = as(d.token);
    await me.post('/doctor/availability', { ...weekly(d.locationId), providerLocationId: undefined }).expect(400);
    await me.post('/doctor/availability', { ...weekly(d.locationId), providerLocationId: randomUUID() }).expect(404);
    await me.post('/doctor/availability', { ...weekly(d.locationId), endTime: '08:00' }).expect(400);
    await me.post('/doctor/availability', { ...weekly(d.locationId), weekday: undefined }).expect(400);
    await me.post('/doctor/availability', { type: 'EXCEPTION_BLOCK', appointmentType: 'BOTH' }).expect(400);
    await me.post('/doctor/availability', { ...weekly(d.locationId), startTime: '9am' }).expect(400);

    // Another facility's location is not one of mine.
    const other = await registeredProvider(ctx, { admin: d.platformAdmin, displayName: 'St. Paul Hospital' });
    const theirs = body(await as(other.token).post('/provider/locations', { name: 'Gulele', city: 'Addis Ababa', lat: 9.05, lng: 38.72 }).expect(201)).locationId as string;
    await me.post('/doctor/availability', weekly(theirs)).expect(404);

    await me.patch('/doctor/profile', { acceptsTelemedicine: false }).expect(200);
    const video = await me.post('/doctor/availability', { type: 'RECURRING', weekday: 2, startTime: '18:00', endTime: '20:00', appointmentType: 'TELEMEDICINE' });
    expect(video.status).toBe(422);
  });

  it('a weekly pattern makes 60 days of open slots in local time; patients see them with the place', async () => {
    const d = await doctorAtHospital();
    const me = as(d.token);
    const added = body(await me.post('/doctor/availability', weekly(d.locationId)).expect(201));
    expect(added.slotsCreated).toBeGreaterThanOrEqual(32); // 8 or 9 Mondays × 4 slots
    expect(body(await me.get('/doctor/availability').expect(200)).items).toHaveLength(1);

    const monday = nextMonday();
    const open = body(await request(ctx.server).get(`/doctors/${d.doctorId}/slots?from=${monday}&to=${monday}`).expect(200)).items as Array<Record<string, unknown>>;
    expect(open.map((s) => s.startAt)).toEqual(['09:00', '09:30', '10:00', '10:30'].map((t) => localInstant(monday, t).toISOString()));
    expect(open[0]).toMatchObject({ appointmentType: 'IN_PERSON', location: { locationId: d.locationId, providerId: d.provider.providerId, name: 'Main campus', city: 'Addis Ababa' } });
    expect(body(await request(ctx.server).get(`/doctors/${d.doctorId}/slots?from=${monday}&to=${monday}&type=TELEMEDICINE`).expect(200)).items).toEqual([]);
    await request(ctx.server).get(`/doctors/${d.doctorId}/slots?from=${monday}&to=${localDate(new Date(Date.parse(monday) + 40 * DAY))}`).expect(400);

    // Regeneration is idempotent.
    expect(await ctx.app.get(AvailabilityService).regenerate(d.doctorId)).toEqual({ created: 0, removed: 0 });
  });

  it('time off removes slots; removing it brings them back; held slots are never touched', async () => {
    const d = await doctorAtHospital();
    const me = as(d.token);
    await me.post('/doctor/availability', weekly(d.locationId)).expect(201);
    const monday = nextMonday();
    const slotsOn = async () => (body(await me.get(`/doctor/slots?from=${monday}&to=${monday}`).expect(200)).items as Array<{ slotId: string; status: string }>);

    const meeting = body(await me.post('/doctor/availability', { type: 'EXCEPTION_BLOCK', fromDate: monday, startTime: '09:45', endTime: '10:15', appointmentType: 'BOTH' }).expect(201));
    expect((await slotsOn()).length).toBe(2);
    await me.del(`/doctor/availability/${meeting.ruleId}`).expect(200);
    expect((await slotsOn()).length).toBe(4);

    const dayOff = body(await me.post('/doctor/availability', { type: 'EXCEPTION_BLOCK', fromDate: monday, appointmentType: 'BOTH' }).expect(201));
    expect(await slotsOn()).toEqual([]);
    await me.del(`/doctor/availability/${dayOff.ruleId}`).expect(200);

    const [first] = await slotsOn();
    await ctx.prisma.appointmentSlot.update({ where: { id: first.slotId }, data: { status: 'HELD', heldBy: d.person.userId, heldUntil: new Date(Date.now() + 10 * 60_000) } });
    const rule = (body(await me.get('/doctor/availability').expect(200)).items as Array<{ ruleId: string }>)[0];
    await me.del(`/doctor/availability/${rule.ruleId}`).expect(200);
    expect((await slotsOn()).map((s) => [s.slotId, s.status])).toEqual([[first.slotId, 'HELD']]);
  });

  it('a doctor blocks and opens a single slot; patients never see a blocked one', async () => {
    const d = await doctorAtHospital();
    const me = as(d.token);
    await me.post('/doctor/availability', weekly(d.locationId)).expect(201);
    const monday = nextMonday();
    const [slot] = body(await me.get(`/doctor/slots?from=${monday}&to=${monday}`).expect(200)).items as Array<{ slotId: string }>;

    expect(body(await me.post(`/doctor/slots/${slot.slotId}/block`).expect(200))).toEqual({ slotId: slot.slotId, status: 'BLOCKED' });
    await me.post(`/doctor/slots/${slot.slotId}/block`).expect(409);
    const visible = body(await request(ctx.server).get(`/doctors/${d.doctorId}/slots?from=${monday}&to=${monday}`).expect(200)).items as Array<{ slotId: string }>;
    expect(visible.map((s) => s.slotId)).not.toContain(slot.slotId);
    await me.post(`/doctor/slots/${slot.slotId}/unblock`).expect(200);
    await me.post(`/doctor/slots/${randomUUID()}/block`).expect(404);

    // Another doctor cannot touch my slots.
    const other = await registeredDoctor(ctx, { admin: d.platformAdmin, fullName: 'Dr. Abebe Kebede' });
    await as(other.token).post(`/doctor/slots/${slot.slotId}/block`).expect(404);
  });

  it('doctors are searchable by name, specialty, facility and telemedicine, soonest available first', async () => {
    const d = await doctorAtHospital();
    await as(d.token).post('/doctor/availability', weekly(d.locationId)).expect(201);
    const idle = await registeredDoctor(ctx, { admin: d.platformAdmin, fullName: 'Dr. Abebe Kebede', specialty: 'Paediatrics' });
    await ctx.drainOutbox();

    const ids = async (query: string) => (body(await request(ctx.server).get(`/search/doctors${query}`).expect(200)).items as Array<{ doctorId: string }>).map((i) => i.doctorId);
    expect(await ids('')).toEqual([d.doctorId, idle.doctorId]);
    expect(await ids('?q=selamawit')).toEqual([d.doctorId]);
    expect(await ids('?q=cardiology')).toEqual([d.doctorId]);
    expect(await ids('?q=anbessa')).toEqual([d.doctorId]);
    expect(await ids('?specialty=paediatrics')).toEqual([idle.doctorId]);
    expect(await ids(`?providerId=${d.provider.providerId}`)).toEqual([d.doctorId]);
    expect(await ids('?telemedicine=true')).toEqual([d.doctorId]);
    expect(await ids('?availableOnly=true')).toEqual([d.doctorId]);
    expect(await ids('?lat=9.02&lng=38.75&radiusKm=10')).toEqual([d.doctorId]);
    await request(ctx.server).get('/search/doctors?sort=distance').expect(400);

    const typo = body(await request(ctx.server).get('/search/doctors?q=selamawt').expect(200));
    expect(typo).toMatchObject({ match: 'SIMILAR', didYouMean: 'Dr. Selamawit Bekele' });
    const [hit] = typo.items as Array<Record<string, unknown>>;
    expect(hit).toMatchObject({
      fullName: 'Dr. Selamawit Bekele',
      specialty: 'Cardiology',
      acceptsTelemedicine: true,
      feeInPerson: 50000,
      practices: [{ providerId: d.provider.providerId, name: 'Tikur Anbessa Hospital', city: 'Addis Ababa' }],
      city: 'Addis Ababa',
    });
    expect(new Date(hit.nextAvailableAt as string).getTime()).toBeGreaterThan(Date.now());

    // A disabled doctor leaves search.
    await as(d.platformAdmin.accessToken).post(`/admin/doctors/${d.doctorId}/suspend`, { reason: 'Complaint under review' }).expect(200);
    await ctx.drainOutbox();
    expect(await ids('')).toEqual([idle.doctorId]);
    const refused = await request(ctx.server).get(`/doctors/${d.doctorId}/slots`);
    expect(refused.status).toBe(404);
    expect(errorOf(refused).code).toBe('DOCTOR_NOT_FOUND');
  });
});
