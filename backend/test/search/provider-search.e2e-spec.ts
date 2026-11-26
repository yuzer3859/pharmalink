import request from 'supertest';
import { randomUUID } from 'crypto';
import { SearchProjectorService } from '../../src/modules/search/application/search-projector.service';
import { auth, body } from '../support/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';
import { registeredProvider } from '../provider-directory/support';

/**
 * Work 162: customers find healthcare providers and compare diagnostic services (module-14
 * F-SR-07/08, module-09 §8.1): typo-tolerant text, type, specialty, service and emergency
 * filters, nearest first with a location, price comparison; only eligible providers appear; kept
 * in sync by Module 09's events.
 */
describe('Search — healthcare providers and diagnostic services (Work 162, e2e)', () => {
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

  const get = (path: string) => request(ctx.server).get(path);
  const items = async (path: string) => body(await get(path).expect(200)).items as Array<Record<string, unknown>>;
  const send = (token: string, method: 'post' | 'patch' | 'put', path: string, payload: object) =>
    request(ctx.server)[method](path).set(...auth(token)).send(payload);

  /** A hospital in Bole (Addis Ababa) with a cardiology department and 24/7 emergency. */
  async function hospital() {
    const p = await registeredProvider(ctx, { displayName: 'Tikur Anbessa Hospital' });
    await send(p.token, 'post', '/provider/locations', { name: 'Main campus', city: 'Addis Ababa', subcity: 'Lideta', lat: 9.0206, lng: 38.7469, emergencyAvailability: 'H24_7' }).expect(201);
    await send(p.token, 'post', '/provider/departments', { name: 'Cardiology', specialty: 'Cardiology' }).expect(201);
    await ctx.drainOutbox();
    return p;
  }

  /** A lab in Hawassa (about 270 km from Addis Ababa) with two tests. */
  async function lab(name = 'Bethel Medical Laboratory', price = 25000) {
    const p = await registeredProvider(ctx, { type: 'LAB', displayName: name });
    const location = body(await send(p.token, 'post', '/provider/locations', { name: 'Hawassa branch', city: 'Hawassa', lat: 7.0621, lng: 38.4764 }).expect(201)).locationId as string;
    const cbc = body(await send(p.token, 'post', '/provider/services', { type: 'LAB_TEST', name: 'Complete blood count', code: 'CBC', price, preparationInstructions: 'No fasting needed.', locationId: location }).expect(201)).serviceId as string;
    const xray = body(await send(p.token, 'post', '/provider/services', { type: 'IMAGING', name: 'Chest X-ray', price: 40000 }).expect(201)).serviceId as string;
    await ctx.drainOutbox();
    return { ...p, cbc, xray };
  }

  it('finds a hospital by name, specialty and type words, with typo tolerance, kept in sync by events', async () => {
    const h = await hospital();
    for (const q of ['anbessa', 'cardiology', 'hospital', encodeURIComponent('ሆስፒታል'), 'lideta']) {
      expect((await items(`/search/providers?q=${q}`)).map((i) => i.providerId)).toEqual([h.providerId]);
    }
    const typo = body(await get('/search/providers?q=cardiolgy').expect(200));
    expect(typo).toMatchObject({ match: 'SIMILAR', didYouMean: 'Tikur Anbessa Hospital', total: 1 });
    expect((typo.items as unknown[])[0]).toEqual(
      expect.objectContaining({ providerId: h.providerId, type: 'HOSPITAL', name: 'Tikur Anbessa Hospital', city: 'Addis Ababa', emergency: 'H24_7', specialties: ['Cardiology'], serviceTypes: [] }),
    );
    expect(await items('/search/providers?q=pharmacy')).toEqual([]);
  });

  it('filters by type, city, specialty, service and emergency, and ranks nearest first', async () => {
    const h = await hospital();
    const l = await lab();
    const ids = async (query: string) => (await items(`/search/providers${query}`)).map((i) => i.providerId);

    expect(await ids('?type=LAB')).toEqual([l.providerId]);
    expect(await ids('?city=addis%20ababa')).toEqual([h.providerId]);
    expect(await ids('?specialty=cardiology')).toEqual([h.providerId]);
    expect(await ids('?serviceType=IMAGING')).toEqual([l.providerId]);
    expect(await ids('?emergency=true')).toEqual([h.providerId]);
    expect(await ids('?lat=7.05&lng=38.48')).toEqual([l.providerId]);
    // From near Hawassa with a wide radius: the lab (~50 km) before the hospital (~170 km).
    expect(await ids('?lat=7.5&lng=38.5&radiusKm=200')).toEqual([l.providerId, h.providerId]);
    expect(await ids('?lat=9.02&lng=38.75&radiusKm=10')).toEqual([h.providerId]);
    const near = await items('/search/providers?lat=9.03&lng=38.75&radiusKm=10');
    expect(near[0].distanceMeters).toBeGreaterThan(500);
    expect(near[0].distanceMeters).toBeLessThan(2_000);
    await get('/search/providers?type=PHARMACY').expect(400);
    await get('/search/providers?lat=9.02').expect(400);
  });

  it('compares a test across labs by price, and by distance with a location', async () => {
    const cheap = await lab('Bethel Medical Laboratory', 25000);
    const dear = await lab('Hawassa Diagnostic Laboratory', 30000);
    const page = body(await get('/search/services?q=blood%20count&sort=price').expect(200));
    expect((page.items as Array<Record<string, unknown>>).map((i) => [i.serviceId, i.price])).toEqual([
      [cheap.cbc, 25000],
      [dear.cbc, 30000],
    ]);
    expect((page.items as unknown[])[0]).toEqual(
      expect.objectContaining({
        name: 'Complete blood count',
        serviceType: 'LAB_TEST',
        code: 'CBC',
        currency: 'ETB',
        preparationInstructions: 'No fasting needed.',
        provider: { providerId: cheap.providerId, name: 'Bethel Medical Laboratory', type: 'LAB' },
        locationName: 'Hawassa branch',
        city: 'Hawassa',
      }),
    );
    expect((await items('/search/services?serviceType=IMAGING')).map((i) => i.serviceId).sort()).toEqual([cheap.xray, dear.xray].sort());
    expect((await items(`/search/services?providerId=${dear.providerId}`)).map((i) => i.serviceId).sort()).toEqual([dear.cbc, dear.xray].sort());
    expect(body(await get('/search/services?q=blod%20count').expect(200))).toMatchObject({ match: 'SIMILAR', total: 2 });
    const withDistance = await items('/search/services?q=cbc&lat=7.06&lng=38.47&sort=distance');
    expect(withDistance.every((i) => typeof i.distanceMeters === 'number')).toBe(true);
    await get('/search/services?sort=distance').expect(400);

    // A test taken off the menu disappears.
    await send(cheap.token, 'patch', `/provider/services/${cheap.cbc}`, { isAvailable: false }).expect(200);
    await ctx.drainOutbox();
    expect((await items('/search/services?q=blood%20count')).map((i) => i.serviceId)).toEqual([dear.cbc]);
  });

  it('a provider’s public page shows its locations, departments and services; a suspended one disappears everywhere', async () => {
    const h = await hospital();
    const l = await lab();
    const page = body(await get(`/providers/${h.providerId}`).expect(200));
    expect(page).toEqual(
      expect.objectContaining({
        providerId: h.providerId,
        type: 'HOSPITAL',
        displayName: 'Tikur Anbessa Hospital',
        locations: [expect.objectContaining({ name: 'Main campus', emergencyAvailability: 'H24_7', hours: [], facilities: [] })],
        departments: [expect.objectContaining({ name: 'Cardiology', specialty: 'Cardiology' })],
        services: [],
      }),
    );
    expect(page).not.toHaveProperty('organizationId');
    expect((body(await get(`/providers/${l.providerId}/services`).expect(200)).items as unknown[]).length).toBe(2);
    await get(`/providers/${randomUUID()}`).expect(404);

    await send(l.platformAdmin.accessToken, 'post', `/admin/providers/${l.providerId}/suspend`, { reason: 'Inspection pending' }).expect(200);
    await ctx.drainOutbox();
    expect((await items('/search/providers')).map((i) => i.providerId)).toEqual([h.providerId]);
    expect(await items('/search/services')).toEqual([]);
    await get(`/providers/${l.providerId}`).expect(404);
    await get(`/providers/${l.providerId}/services`).expect(404);
  });

  it('a full reindex rebuilds providers and services from Module 09', async () => {
    const h = await hospital();
    const l = await lab();
    await ctx.prisma.searchDocument.deleteMany({});
    const report = await ctx.app.get(SearchProjectorService).reindexAll();
    expect(report).toMatchObject({ providers: 2, failures: 0 });
    expect((await items('/search/providers')).map((i) => i.providerId).sort()).toEqual([h.providerId, l.providerId].sort());
    expect((await items('/search/services')).length).toBe(2);
  });
});
