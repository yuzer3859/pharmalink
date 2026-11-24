import request from 'supertest';
import { auth, body, createUserWithRole, errorOf } from '../support/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';
import { createActivatedPharmacy, grantOrgRole } from '../pharmacy-inventory/support';

/**
 * Work 153: the Super Admin's pharmacy register — find a pharmacy by name, see who it is (its
 * registration, licence, owner and people), and disable it or enable it again.
 */
describe('Admin — pharmacy record (Work 153, e2e)', () => {
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

  const list = async (token: string, query: string) =>
    body(await request(ctx.server).get(`/admin/operations/pharmacies?${query}`).set(...auth(token)).expect(200)) as {
      items: Array<Record<string, unknown>>;
      total: number;
    };

  it('finds a pharmacy by part of its name, any case', async () => {
    const admin = await createUserWithRole(ctx, 'ADMIN');
    const bole = await createActivatedPharmacy(ctx);
    await createActivatedPharmacy(ctx);
    await request(ctx.server).patch('/pharmacy/profile').set(...auth(bole.accessToken)).send({ displayName: 'Bole 100% Pharmacy' }).expect(200);

    const found = await list(admin.accessToken, 'q=bole');
    expect(found.total).toBe(1);
    expect(found.items[0]).toEqual(expect.objectContaining({ pharmacyId: bole.pharmacyId, organizationId: bole.organizationId, displayName: 'Bole 100% Pharmacy' }));
    // ILIKE wildcards in the search are matched literally.
    expect((await list(admin.accessToken, `q=${encodeURIComponent('100%')}`)).total).toBe(1);
    expect((await list(admin.accessToken, `q=${encodeURIComponent('_')}`)).total).toBe(0);
    expect((await list(admin.accessToken, '')).total).toBe(2);
  });

  it('shows the organisation behind it: registration, licence, owner and staff', async () => {
    const admin = await createUserWithRole(ctx, 'ADMIN');
    const pharmacy = await createActivatedPharmacy(ctx);
    const pharmacist = await grantOrgRole(ctx, 'PHARMACIST', pharmacy.organizationId);

    const people = body(await request(ctx.server).get(`/admin/operations/pharmacies/${pharmacy.pharmacyId}/people`).set(...auth(admin.accessToken)).expect(200));
    expect(people).toEqual(
      expect.objectContaining({
        organizationId: pharmacy.organizationId,
        type: 'PHARMACY',
        status: 'ACTIVE',
        licenseNumber: expect.any(String),
        createdAt: expect.any(String),
        owner: expect.objectContaining({ userId: pharmacy.userId, phone: pharmacy.phone }),
      }),
    );
    const members = people.members as Array<{ userId: string; roles: string[] }>;
    expect(members.find((m) => m.userId === pharmacy.userId)?.roles).toEqual(['PHARMACY_OWNER']);
    expect(members.find((m) => m.userId === pharmacist.userId)?.roles).toEqual(['PHARMACIST']);

    await request(ctx.server).get('/admin/operations/pharmacies/00000000-0000-4000-8000-000000000000/people').set(...auth(admin.accessToken)).expect(404);
    expect((await request(ctx.server).get(`/admin/operations/pharmacies/${pharmacy.pharmacyId}/people`).set(...auth(pharmacy.accessToken))).status).toBe(403);
  });

  it('disables a pharmacy with a reason, and enables it again after re-checking its licence', async () => {
    const admin = await createUserWithRole(ctx, 'ADMIN');
    const pharmacy = await createActivatedPharmacy(ctx);
    const suspend = (token: string, reason: string) =>
      request(ctx.server).post('/pharmacy/suspend').set(...auth(token)).send({ pharmacyId: pharmacy.pharmacyId, reason });

    expect((await suspend(admin.accessToken, ' x ')).status).toBe(400);
    expect((await suspend(pharmacy.accessToken, 'Owner tries it')).status).toBe(403);

    const done = await suspend(admin.accessToken, 'Licence under investigation.');
    expect(done.status).toBe(201);
    expect(body(done)).toEqual({ pharmacyId: pharmacy.pharmacyId, transactingStatus: 'SUSPENDED', changed: true });
    const detail = body(await request(ctx.server).get(`/admin/operations/pharmacies/${pharmacy.pharmacyId}`).set(...auth(admin.accessToken)).expect(200));
    expect(detail).toEqual(expect.objectContaining({ transactingStatus: 'SUSPENDED', eligible: false }));
    const audit = await ctx.prisma.auditLog.findFirst({ where: { action: 'PHARMACY_SUSPENDED', resourceId: pharmacy.pharmacyId } });
    expect(audit?.actorUserId).toBe(admin.userId);
    expect(audit?.context).toEqual(expect.objectContaining({ reason: 'Licence under investigation.' }));

    // A second disable changes nothing.
    expect(body(await suspend(admin.accessToken, 'Again, by mistake.')).changed).toBe(false);

    await request(ctx.server).post('/pharmacy/activate').set(...auth(admin.accessToken)).send({ pharmacyId: pharmacy.pharmacyId }).expect(201);
    const again = body(await request(ctx.server).get(`/admin/operations/pharmacies/${pharmacy.pharmacyId}`).set(...auth(admin.accessToken)).expect(200));
    expect(again).toEqual(expect.objectContaining({ transactingStatus: 'ACTIVE', eligible: true }));
  });

  it('refuses an unknown pharmacy', async () => {
    const admin = await createUserWithRole(ctx, 'ADMIN');
    const res = await request(ctx.server)
      .post('/pharmacy/suspend')
      .set(...auth(admin.accessToken))
      .send({ pharmacyId: '00000000-0000-4000-8000-000000000000', reason: 'Not a real one.' });
    expect(res.status).toBe(404);
    expect(errorOf(res).code).toBe('NOT_FOUND');
  });
});
