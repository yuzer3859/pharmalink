import request from 'supertest';
import { randomUUID } from 'crypto';
import { auth, body, createUserWithRole, errorOf } from '../support/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';
import { registeredProvider } from './support';

/**
 * Work 161: a facility administrator runs their own directory profile (module-09 §8.2): the
 * profile, locations with map position, opening hours and facilities, departments, and — for
 * labs and diagnostic centres — tests, imaging and screening packages.
 */
describe('Provider portal — a facility runs its profile (Work 161, e2e)', () => {
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

  const as = (token: string, headers: Record<string, string> = {}) => {
    const withAuth = (r: request.Test) => {
      r.set(...auth(token));
      for (const [k, v] of Object.entries(headers)) r.set(k, v);
      return r;
    };
    return {
      get: (path: string) => withAuth(request(ctx.server).get(path)),
      post: (path: string, payload: object = {}) => withAuth(request(ctx.server).post(path)).send(payload),
      patch: (path: string, payload: object) => withAuth(request(ctx.server).patch(path)).send(payload),
      put: (path: string, payload: object) => withAuth(request(ctx.server).put(path)).send(payload),
      del: (path: string) => withAuth(request(ctx.server).delete(path)),
    };
  };
  const bole = { name: 'Main campus', city: 'Addis Ababa', subcity: 'Bole', lat: 9.0108, lng: 38.7613, phone: '+251 11 551 7611', emergencyAvailability: 'H24_7' };

  it('reads and updates its profile; the name customers see is not changed here', async () => {
    const p = await registeredProvider(ctx);
    const me = as(p.token);
    expect(body(await me.get('/provider/mine').expect(200)).items).toEqual([
      { providerId: p.providerId, organizationId: p.organizationId, type: 'HOSPITAL', displayName: 'Tikur Anbessa Hospital', status: 'ACTIVE' },
    ]);
    const updated = body(
      await me.patch('/provider/profile', { nameAm: 'ጥቁር አንበሳ ሆስፒታል', description: 'Teaching hospital', website: 'https://tikuranbessa.example', contactEmail: 'info@tikuranbessa.example' }).expect(200),
    );
    expect(updated).toEqual(expect.objectContaining({ displayName: 'Tikur Anbessa Hospital', nameAm: 'ጥቁር አንበሳ ሆስፒታል', description: 'Teaching hospital', contactEmail: 'info@tikuranbessa.example' }));
    await me.patch('/provider/profile', { displayName: 'Something else' }).expect(400);
    await me.patch('/provider/profile', { website: 'javascript:alert(1)' }).expect(400);
    expect(await ctx.prisma.outbox.count({ where: { eventType: 'provider.provider.profile_changed', aggregateId: p.providerId } })).toBe(1);
    expect(await ctx.prisma.auditLog.count({ where: { action: 'PROVIDER_PROFILE_UPDATED', resourceId: p.providerId, actorUserId: p.facilityAdmin.userId } })).toBe(1);
  });

  it('adds locations with their map position, opening hours and facilities; one is primary', async () => {
    const p = await registeredProvider(ctx);
    const me = as(p.token);
    const main = body(await me.post('/provider/locations', bole).expect(201)).locationId as string;
    const piassa = body(await me.post('/provider/locations', { name: 'Piassa clinic', city: 'Addis Ababa', lat: 9.0348, lng: 38.7525, isPrimary: true }).expect(201)).locationId as string;

    const outside = await me.post('/provider/locations', { ...bole, lat: 51.5, lng: -0.12 });
    expect(outside.status).toBe(422);
    expect(errorOf(outside).code).toBe('ADDRESS_OUTSIDE_ETHIOPIA');
    await me.post('/provider/locations', { name: 'No map', city: 'Adama' }).expect(400);

    await me.put(`/provider/locations/${main}/hours`, {
      hours: [
        { weekday: 1, openTime: '08:00', closeTime: '17:30' },
        { weekday: 0, isClosed: true },
      ],
    }).expect(200);
    await me.put(`/provider/locations/${main}/hours`, { hours: [{ weekday: 1, openTime: '08:00', closeTime: '17:00' }, { weekday: 1, isClosed: true }] }).expect(400);
    await me.put(`/provider/locations/${main}/hours`, { hours: [{ weekday: 2 }] }).expect(400);
    await me.put(`/provider/locations/${main}/hours`, { hours: [{ weekday: 2, openTime: '25:00', closeTime: '17:00' }] }).expect(400);
    await me.put(`/provider/locations/${main}/facilities`, { facilities: ['Parking', 'Ambulance', 'Wheelchair access'] }).expect(200);
    await me.patch(`/provider/locations/${main}`, { lat: 9.012 }).expect(200);
    await me.patch(`/provider/locations/${main}`, { name: null }).expect(400);

    const profile = body(await me.get('/provider/profile').expect(200));
    const locations = profile.locations as Array<Record<string, unknown>>;
    expect(locations.map((l) => [l.locationId, l.isPrimary])).toEqual([
      [piassa, true],
      [main, false],
    ]);
    expect(locations[1]).toEqual(
      expect.objectContaining({
        lat: 9.012,
        lng: 38.7613,
        emergencyAvailability: 'H24_7',
        hours: [
          { weekday: 0, openTime: null, closeTime: null, isClosed: true },
          { weekday: 1, openTime: '08:00', closeTime: '17:30', isClosed: false },
        ],
        facilities: ['Ambulance', 'Parking', 'Wheelchair access'],
      }),
    );

    // Removing the primary location makes the remaining one primary.
    expect(body(await me.del(`/provider/locations/${piassa}`).expect(200))).toEqual({ removed: true });
    const after = (body(await me.get('/provider/profile').expect(200)).locations as Array<Record<string, unknown>>).map((l) => [l.locationId, l.isPrimary]);
    expect(after).toEqual([[main, true]]);
    await me.patch(`/provider/locations/${piassa}`, { name: 'Gone' }).expect(404);
  });

  it('a hospital runs departments, and cannot list lab services', async () => {
    const p = await registeredProvider(ctx);
    const me = as(p.token);
    const cardiology = body(await me.post('/provider/departments', { name: 'Cardiology', specialty: 'Cardiology', contactPhone: '+251 11 551 7612' }).expect(201)).departmentId as string;
    await me.patch(`/provider/departments/${cardiology}`, { description: 'Adult and paediatric cardiology' }).expect(200);
    expect(body(await me.del(`/provider/departments/${cardiology}`).expect(200))).toEqual({ closed: true });
    expect((body(await me.get('/provider/profile').expect(200)).departments as unknown[])[0]).toEqual(
      expect.objectContaining({ departmentId: cardiology, name: 'Cardiology', description: 'Adult and paediatric cardiology', isActive: false }),
    );

    const refused = await me.post('/provider/services', { type: 'LAB_TEST', name: 'Complete blood count' });
    expect(refused.status).toBe(422);
  });

  it('a lab lists tests with price and preparation, at one of its locations', async () => {
    const p = await registeredProvider(ctx, { type: 'LAB', displayName: 'Bethel Medical Laboratory' });
    const me = as(p.token);
    const branch = body(await me.post('/provider/locations', { ...bole, name: 'Bole branch' }).expect(201)).locationId as string;
    const cbc = body(
      await me.post('/provider/services', { type: 'LAB_TEST', name: 'Complete blood count', code: 'CBC', price: 25000, durationMinutes: 15, preparationInstructions: 'No fasting needed.', locationId: branch }).expect(201),
    ).serviceId as string;
    const fbs = body(await me.post('/provider/services', { type: 'LAB_TEST', name: 'Fasting blood sugar', price: 15000, preparationInstructions: 'Fast for 8 hours.' }).expect(201)).serviceId as string;
    await me.patch(`/provider/services/${cbc}`, { price: 27500, isAvailable: false }).expect(200);
    await me.post('/provider/services', { type: 'SURGERY', name: 'Nope' }).expect(400);
    await me.post('/provider/services', { type: 'LAB_TEST', name: 'Negative', price: -1 }).expect(400);
    await me.post('/provider/services', { type: 'LAB_TEST', name: 'Elsewhere', locationId: randomUUID() }).expect(404);

    const services = body(await me.get('/provider/profile').expect(200)).services as Array<Record<string, unknown>>;
    expect(services).toEqual([
      expect.objectContaining({ serviceId: cbc, code: 'CBC', price: 27500, currency: 'ETB', isAvailable: false, locationId: branch, preparationInstructions: 'No fasting needed.' }),
      expect.objectContaining({ serviceId: fbs, price: 15000, locationId: null, isAvailable: true }),
    ]);
    expect(body(await me.del(`/provider/services/${fbs}`).expect(200))).toEqual({ removed: true });
  });

  it('reaches only its own facility; a suspended one can be read but not changed', async () => {
    const mine = await registeredProvider(ctx);
    const theirs = await registeredProvider(ctx, { displayName: 'St. Paul Hospital' });
    const location = body(await as(mine.token).post('/provider/locations', bole).expect(201)).locationId as string;

    await as(theirs.token).patch(`/provider/locations/${location}`, { name: 'Taken' }).expect(404);
    await as(theirs.token).del(`/provider/locations/${location}`).expect(404);
    expect((body(await as(theirs.token).get('/provider/profile').expect(200)) as { providerId: string }).providerId).toBe(theirs.providerId);

    const customer = await createUserWithRole(ctx, 'CUSTOMER');
    await as(customer.accessToken).get('/provider/profile').expect(403);

    await as(mine.platformAdmin.accessToken).post(`/admin/providers/${mine.providerId}/suspend`, { reason: 'Inspection pending' }).expect(200);
    const blocked = await as(mine.token).post('/provider/departments', { name: 'Radiology' });
    expect(blocked.status).toBe(403);
    expect(errorOf(blocked).code).toBe('PROVIDER_SUSPENDED');
    await as(mine.token).get('/provider/profile').expect(200);
  });

  it('an administrator of two facilities works in the one the portal chose', async () => {
    const first = await registeredProvider(ctx);
    const second = await registeredProvider(ctx, { type: 'CLINIC', displayName: 'Tikur Anbessa Clinic', admin: first.platformAdmin, facilityAdmin: first.facilityAdmin });
    const me = as(second.token);
    expect((body(await me.get('/provider/mine').expect(200)).items as unknown[]).length).toBe(2);
    expect((body(await me.get('/provider/profile').expect(200)) as { providerId: string }).providerId).toBe(first.providerId);

    const chosen = as(second.token, { 'X-Organization-Id': second.organizationId });
    expect((body(await chosen.get('/provider/profile').expect(200)) as { providerId: string }).providerId).toBe(second.providerId);
    await chosen.post('/provider/departments', { name: 'General practice' }).expect(201);
    expect(await ctx.prisma.department.count({ where: { providerId: second.providerId } })).toBe(1);
    expect(await ctx.prisma.department.count({ where: { providerId: first.providerId } })).toBe(0);

    await as(second.token, { 'X-Organization-Id': randomUUID() }).get('/provider/profile').expect(404);
  });
});
