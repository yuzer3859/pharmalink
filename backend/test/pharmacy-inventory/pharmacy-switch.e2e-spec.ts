import request from 'supertest';
import { auth, body, createUserWithRole, grantRoleDirect, login } from '../support/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';
import { createActivatedPharmacy, createPharmacyOrganization } from './support';

/**
 * Work 155: an owner with several pharmacies (or a pharmacist at more than one) chooses which one
 * a request works in with `X-Organization-Id`; without it, nothing changes.
 */
describe('Pharmacy — working in one of several pharmacies (Work 155, e2e)', () => {
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

  /** One owner, two active pharmacies. */
  async function ownerOfTwo() {
    const first = await createActivatedPharmacy(ctx);
    const { organizationId } = await createPharmacyOrganization(ctx, first.userId, { name: 'Second Org' });
    await grantRoleDirect(ctx, first.userId, 'PHARMACY_OWNER', organizationId);
    const tokens = await login(ctx, first.phone, first.password);
    const registered = body(
      await request(ctx.server).post('/pharmacy/register').set(...auth(tokens.accessToken)).send({ organizationId, displayName: 'Piassa Branch Pharmacy' }).expect(201),
    );
    const admin = await createUserWithRole(ctx, 'ADMIN');
    await request(ctx.server).post('/pharmacy/activate').set(...auth(admin.accessToken)).send({ pharmacyId: registered.pharmacyId }).expect(201);
    return { ...first, ...tokens, second: { organizationId, pharmacyId: registered.pharmacyId as string } };
  }

  const as = (token: string, organizationId?: string) => {
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    if (organizationId) headers['X-Organization-Id'] = organizationId;
    return headers;
  };

  it('lists every pharmacy the owner holds, whatever pharmacy the request chose', async () => {
    const o = await ownerOfTwo();
    const mine = body(await request(ctx.server).get('/pharmacy/mine').set(as(o.accessToken, o.second.organizationId)).expect(200)) as unknown as Array<Record<string, unknown>>;
    expect(mine.map((p) => p.pharmacyId).sort()).toEqual([o.pharmacyId, o.second.pharmacyId].sort());
    expect(mine.find((p) => p.pharmacyId === o.second.pharmacyId)).toEqual(
      expect.objectContaining({ organizationId: o.second.organizationId, displayName: 'Piassa Branch Pharmacy', transactingStatus: 'ACTIVE' }),
    );

    const customer = await createUserWithRole(ctx, 'CUSTOMER');
    expect(body(await request(ctx.server).get('/pharmacy/mine').set(as(customer.accessToken)).expect(200))).toEqual([]);
  });

  it('works in the chosen pharmacy: its profile, its branches', async () => {
    const o = await ownerOfTwo();
    const profile = (org?: string) => request(ctx.server).get('/pharmacy/profile').set(as(o.accessToken, org));
    expect(body(await profile(o.organizationId).expect(200)).id).toBe(o.pharmacyId);
    expect(body(await profile(o.second.organizationId).expect(200)).id).toBe(o.second.pharmacyId);

    await request(ctx.server)
      .post('/pharmacy/branches')
      .set(as(o.accessToken, o.second.organizationId))
      .send({ name: 'Piassa', lat: 9.03, lng: 38.75 })
      .expect(201);
    const branches = (org: string) => request(ctx.server).get('/pharmacy/branches').set(as(o.accessToken, org)).expect(200);
    expect((body(await branches(o.second.organizationId)) as unknown as unknown[]).length).toBe(1);
    expect((body(await branches(o.organizationId)) as unknown as unknown[]).length).toBe(0);
  });

  it("naming a pharmacy the caller does not work in reaches nothing; a malformed header is ignored", async () => {
    const o = await ownerOfTwo();
    const stranger = await createActivatedPharmacy(ctx);
    expect((await request(ctx.server).get('/pharmacy/profile').set(as(o.accessToken, stranger.organizationId))).status).toBe(404);
    expect(body(await request(ctx.server).get('/pharmacy/profile').set(as(o.accessToken, 'not-a-uuid')).expect(200)).id).toEqual(expect.any(String));
  });
});
