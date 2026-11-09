import request from 'supertest';
import { CreateDriverProfileCommand } from '../../src/modules/delivery/application/commands/create-driver-profile.command';
import { VehicleType } from '../../src/modules/delivery/domain/value-objects/vehicle.vo';
import { auth, body, createUserWithRole } from '../support/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';

interface Profile {
  userId: string;
  availability: string;
  onShift: boolean;
  vehicle: { type: string; plateNumber: string | null } | null;
  serviceArea: { lat: number; lng: number; radiusMeters: number } | null;
  lastLocation: { lat: number; lng: number } | null;
  verification: { isEligible: boolean; reason: string | null };
}

/**
 * Work 117: the driver's own routes for the driver app (module-08 §9.1): profile, availability
 * (going online starts the shift; online needs a verified driver) and location.
 */
describe('Driver self-service routes (Work 117, e2e)', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
    await ctx.reset();
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  async function driver(options: { verified: boolean }) {
    const user = await createUserWithRole(ctx, 'DRIVER');
    await ctx.prisma.user.update({ where: { id: user.userId }, data: { primaryRole: 'DRIVER' } });
    if (options.verified) {
      await ctx.prisma.verificationRequest.create({ data: { userId: user.userId, type: 'DRIVER_DOCS', status: 'APPROVED', reviewedAt: new Date() } });
    }
    await ctx.app.get(CreateDriverProfileCommand).execute({
      userId: user.userId,
      vehicleType: VehicleType.Motorcycle,
      plateNumber: `AA-${Math.floor(Math.random() * 99_999)}`,
      serviceArea: { lat: 9.02, lng: 38.75, radiusMeters: 20_000 },
    });
    return user;
  }

  const as = (token: string) => ({
    get: (path: string) => request(ctx.server).get(path).set(...auth(token)),
    put: (path: string, payload: object) => request(ctx.server).put(path).set(...auth(token)).send(payload),
    post: (path: string, payload: object) => request(ctx.server).post(path).set(...auth(token)).send(payload),
  });

  it('reads the driver’s own profile with its verification state', async () => {
    const d = await driver({ verified: true });
    const profile = body(await as(d.accessToken).get('/driver/profile').expect(200)) as unknown as Profile;
    expect(profile).toMatchObject({
      userId: d.userId,
      availability: 'OFFLINE',
      onShift: false,
      serviceArea: { lat: 9.02, lng: 38.75, radiusMeters: 20_000 },
      verification: { isEligible: true, reason: null },
    });
    expect(profile.vehicle?.type).toBeDefined();
  });

  it('going online starts the shift; going offline ends it', async () => {
    const d = await driver({ verified: true });
    const online = body(await as(d.accessToken).put('/driver/availability', { status: 'ONLINE' }).expect(200)) as unknown as Profile;
    expect(online).toMatchObject({ availability: 'ONLINE', onShift: true });
    // Again is harmless.
    await as(d.accessToken).put('/driver/availability', { status: 'ONLINE' }).expect(200);

    const offline = body(await as(d.accessToken).put('/driver/availability', { status: 'OFFLINE' }).expect(200)) as unknown as Profile;
    expect(offline).toMatchObject({ availability: 'OFFLINE', onShift: false });
  });

  it('an unverified driver cannot go online, and is told why', async () => {
    const d = await driver({ verified: false });
    const profile = body(await as(d.accessToken).get('/driver/profile').expect(200)) as unknown as Profile;
    expect(profile.verification.isEligible).toBe(false);
    expect(profile.verification.reason).not.toBeNull();
    const res = await as(d.accessToken).put('/driver/availability', { status: 'ONLINE' });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    const after = body(await as(d.accessToken).get('/driver/profile').expect(200)) as unknown as Profile;
    expect(after.availability).toBe('OFFLINE');
  });

  it('reports the location, and acknowledges without writing a report sent too soon after the last', async () => {
    const d = await driver({ verified: true });
    await as(d.accessToken).put('/driver/availability', { status: 'ONLINE' }).expect(200);

    const first = body(await as(d.accessToken).post('/delivery/location', { lat: 9.03, lng: 38.76 }).expect(200));
    expect(first).toMatchObject({ applied: true, throttled: false });
    const second = body(await as(d.accessToken).post('/delivery/location', { lat: 9.04, lng: 38.77 }).expect(200));
    expect(second).toMatchObject({ applied: false, throttled: true });

    const profile = body(await as(d.accessToken).get('/driver/profile').expect(200)) as unknown as Profile;
    expect(profile.lastLocation).toMatchObject({ lat: 9.03, lng: 38.76 });
    await as(d.accessToken).post('/delivery/location', { lat: 91, lng: 38.77 }).expect(400);
  });

  it('refuses a status other than ONLINE or OFFLINE, an account with no driver profile, and a customer', async () => {
    const d = await driver({ verified: true });
    await as(d.accessToken).put('/driver/availability', { status: 'BUSY' }).expect(400);

    const noProfile = await createUserWithRole(ctx, 'DRIVER');
    await as(noProfile.accessToken).get('/driver/profile').expect(404);

    const customer = await createUserWithRole(ctx, 'CUSTOMER');
    await as(customer.accessToken).get('/driver/profile').expect(403);
  });
});
