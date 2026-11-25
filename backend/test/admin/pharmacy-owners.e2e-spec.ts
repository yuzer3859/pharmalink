import request from 'supertest';
import { auth, body, createUserWithRole, grantRoleDirect, login } from '../support/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';
import { createActivatedPharmacy, createPharmacyOrganization } from '../pharmacy-inventory/support';

/**
 * Work 157: the Super Admin's pharmacy owners — each owner with every pharmacy they own; disabling
 * an owner (and, when asked, all their pharmacies) and enabling them again.
 */
describe('Admin — pharmacy owners (Work 157, e2e)', () => {
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

  async function ownerOfTwo() {
    const first = await createActivatedPharmacy(ctx);
    const { organizationId } = await createPharmacyOrganization(ctx, first.userId, { name: 'Second Org' });
    await grantRoleDirect(ctx, first.userId, 'PHARMACY_OWNER', organizationId);
    const tokens = await login(ctx, first.phone, first.password);
    const second = body(
      await request(ctx.server).post('/pharmacy/register').set(...auth(tokens.accessToken)).send({ organizationId, displayName: 'Second Pharmacy' }).expect(201),
    ).pharmacyId as string;
    const admin = await createUserWithRole(ctx, 'ADMIN');
    await request(ctx.server).post('/pharmacy/activate').set(...auth(admin.accessToken)).send({ pharmacyId: second }).expect(201);
    return { ...first, secondPharmacyId: second, admin };
  }

  const status = async (token: string, pharmacyId: string) =>
    body(await request(ctx.server).get(`/admin/operations/pharmacies/${pharmacyId}`).set(...auth(token)).expect(200)).transactingStatus;

  it('lists owners with what they own, by exact phone or e-mail; a customer is not an owner', async () => {
    const o = await ownerOfTwo();
    await createUserWithRole(ctx, 'CUSTOMER');
    const all = body(await request(ctx.server).get('/admin/pharmacy-owners').set(...auth(o.admin.accessToken)).expect(200));
    expect(all.total).toBe(1);
    expect((all.items as Array<Record<string, unknown>>)[0]).toEqual(expect.objectContaining({ userId: o.userId, phone: o.phone, pharmacyCount: 2 }));
    const found = body(await request(ctx.server).get(`/admin/pharmacy-owners?identifier=${encodeURIComponent(o.phone)}`).set(...auth(o.admin.accessToken)).expect(200));
    expect(found.total).toBe(1);

    const record = body(await request(ctx.server).get(`/admin/pharmacy-owners/${o.userId}`).set(...auth(o.admin.accessToken)).expect(200));
    const pharmacies = record.pharmacies as Array<{ pharmacyId: string; transactingStatus: string }>;
    expect(pharmacies.map((p) => p.pharmacyId).sort()).toEqual([o.pharmacyId, o.secondPharmacyId].sort());
    expect(pharmacies.every((p) => p.transactingStatus === 'ACTIVE')).toBe(true);

    const customer = await createUserWithRole(ctx, 'CUSTOMER');
    await request(ctx.server).get(`/admin/pharmacy-owners/${customer.userId}`).set(...auth(o.admin.accessToken)).expect(404);
  });

  it('disables the owner and all their pharmacies, then enables them again', async () => {
    const o = await ownerOfTwo();
    const disabled = body(
      await request(ctx.server)
        .post(`/admin/pharmacy-owners/${o.userId}/disable`)
        .set(...auth(o.admin.accessToken))
        .send({ reason: 'Licence fraud under investigation.', alsoPharmacies: true })
        .expect(200),
    );
    expect((disabled.pharmacies as Array<{ outcome: string }>).map((p) => p.outcome)).toEqual(['disabled', 'disabled']);
    expect((await ctx.prisma.user.findUniqueOrThrow({ where: { id: o.userId } })).status).toBe('SUSPENDED');
    expect(await status(o.admin.accessToken, o.pharmacyId)).toBe('SUSPENDED');
    expect(await status(o.admin.accessToken, o.secondPharmacyId)).toBe('SUSPENDED');

    const enabled = body(
      await request(ctx.server).post(`/admin/pharmacy-owners/${o.userId}/enable`).set(...auth(o.admin.accessToken)).send({ alsoPharmacies: true }).expect(200),
    );
    expect((enabled.pharmacies as Array<{ outcome: string }>).map((p) => p.outcome)).toEqual(['enabled', 'enabled']);
    expect((await ctx.prisma.user.findUniqueOrThrow({ where: { id: o.userId } })).status).toBe('ACTIVE');
    expect(await status(o.admin.accessToken, o.secondPharmacyId)).toBe('ACTIVE');
  });

  it('can disable the owner alone, and refuses anyone without the permissions', async () => {
    const o = await ownerOfTwo();
    await request(ctx.server)
      .post(`/admin/pharmacy-owners/${o.userId}/disable`)
      .set(...auth(o.admin.accessToken))
      .send({ reason: 'Account review.', alsoPharmacies: false })
      .expect(200);
    expect(await status(o.admin.accessToken, o.pharmacyId)).toBe('ACTIVE');

    const customer = await createUserWithRole(ctx, 'CUSTOMER');
    expect((await request(ctx.server).get('/admin/pharmacy-owners').set(...auth(customer.accessToken))).status).toBe(403);
    expect((await request(ctx.server).post(`/admin/pharmacy-owners/${o.userId}/disable`).set(...auth(customer.accessToken)).send({ reason: 'x x x', alsoPharmacies: true })).status).toBe(403);
  });
});
