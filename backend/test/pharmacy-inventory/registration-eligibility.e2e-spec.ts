import request from 'supertest';
import { auth, body, createUserWithRole, errorOf, grantRoleDirect, login, registerAndVerify } from '../support/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';
import { LicenseExpirySweeper } from '../../src/modules/pharmacy-inventory/infrastructure/scheduling/license-expiry.sweeper';
import { createPharmacyOrganization } from './support';

/**
 * Registration/eligibility lifecycle (module-04 §18): register -> PENDING; activate -> ACTIVE;
 * listing creation blocked while PENDING/SUSPENDED; license-expiry sweeper flips ACTIVE ->
 * SUSPENDED and hides listings from availability.
 */
describe('Pharmacy registration & eligibility (e2e)', () => {
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

  it('registers a pharmacy as PENDING and rejects a second registration for the same org', async () => {
    const owner = await registerAndVerify(ctx);
    const { organizationId } = await createPharmacyOrganization(ctx, owner.userId);
    await grantRoleDirect(ctx, owner.userId, 'PHARMACY_OWNER', organizationId);
    const tokens = await login(ctx, owner.phone, owner.password);

    const res = await request(ctx.server)
      .post('/pharmacy/register')
      .set(...auth(tokens.accessToken))
      .send({ organizationId, displayName: 'My Pharmacy' })
      .expect(201);
    expect(body(res).transactingStatus).toBe('PENDING');

    const dup = await request(ctx.server)
      .post('/pharmacy/register')
      .set(...auth(tokens.accessToken))
      .send({ organizationId, displayName: 'My Pharmacy Again' });
    expect(dup.status).toBe(409);
    expect(errorOf(dup).code).toBe('PHARMACY_ALREADY_REGISTERED');
  });

  it('blocks listing creation while the pharmacy is PENDING, then allows it after activation', async () => {
    const owner = await registerAndVerify(ctx);
    const { organizationId } = await createPharmacyOrganization(ctx, owner.userId);
    await grantRoleDirect(ctx, owner.userId, 'PHARMACY_OWNER', organizationId);
    const tokens = await login(ctx, owner.phone, owner.password);

    const registered = body(
      await request(ctx.server)
        .post('/pharmacy/register')
        .set(...auth(tokens.accessToken))
        .send({ organizationId, displayName: 'My Pharmacy' })
        .expect(201),
    );

    const branch = body(
      await request(ctx.server)
        .post('/pharmacy/branches')
        .set(...auth(tokens.accessToken))
        .send({ name: 'Main Branch' })
        .expect(201),
    );

    const admin = await createUserWithRole(ctx, 'ADMIN');
    const mfr = body(
      await request(ctx.server)
        .post('/admin/catalog/manufacturers')
        .set(...auth(admin.accessToken))
        .send({ name: 'Acme Pharma' })
        .expect(201),
    );
    const product = body(
      await request(ctx.server)
        .post('/admin/catalog/products')
        .set(...auth(admin.accessToken))
        .send({
          type: 'MEDICINE',
          genericName: 'Amoxicillin',
          manufacturerId: mfr.id,
          dosageForm: 'CAPSULE',
          strengthValue: 500,
          strengthUnit: 'MG',
          rxClassification: 'OTC',
          nameEn: 'Amoxicillin 500mg',
        })
        .expect(201),
    );
    // Published only through catalogue review (module-16 Work 30): submit (DRAFT -> PENDING_REVIEW), then approve (-> ACTIVE).
    await request(ctx.server).post(`/admin/catalog/review/${product.id as string}/submit`).set(...auth(admin.accessToken)).expect(200);
    await request(ctx.server).post(`/admin/catalog/review/${product.id as string}/approve`).set(...auth(admin.accessToken)).expect(200);

    const listingDto = {
      catalogProductId: product.id,
      branchId: branch.branchId,
      price: 1000,
      batchNumber: 'B-1',
      initialQuantity: 20,
      expiryDate: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
    };

    const blocked = await request(ctx.server)
      .post('/inventory/listings')
      .set(...auth(tokens.accessToken))
      .send(listingDto);
    expect(blocked.status).toBe(403);
    expect(errorOf(blocked).code).toBe('PHARMACY_NOT_ELIGIBLE');

    await request(ctx.server)
      .post('/pharmacy/activate')
      .set(...auth(admin.accessToken))
      .send({ pharmacyId: registered.pharmacyId })
      .expect(201);

    const created = await request(ctx.server)
      .post('/inventory/listings')
      .set(...auth(tokens.accessToken))
      .send(listingDto);
    expect(created.status).toBe(201);
  });

  it('the license-expiry sweeper suspends an ACTIVE pharmacy whose license already expired and hides its listings', async () => {
    const owner = await registerAndVerify(ctx);
    const { organizationId } = await createPharmacyOrganization(ctx, owner.userId, {
      licenseExpiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
    });
    await grantRoleDirect(ctx, owner.userId, 'PHARMACY_OWNER', organizationId);
    const tokens = await login(ctx, owner.phone, owner.password);

    const registered = body(
      await request(ctx.server)
        .post('/pharmacy/register')
        .set(...auth(tokens.accessToken))
        .send({ organizationId, displayName: 'My Pharmacy' })
        .expect(201),
    );

    const admin = await createUserWithRole(ctx, 'ADMIN');
    await request(ctx.server)
      .post('/pharmacy/activate')
      .set(...auth(admin.accessToken))
      .send({ pharmacyId: registered.pharmacyId })
      .expect(201);

    // Simulate the license already having expired (past-due), as the spec's e2e strategy directs.
    await ctx.prisma.pharmacy.update({
      where: { id: registered.pharmacyId as string },
      data: { licenseExpiresAt: new Date(Date.now() - 60_000) },
    });

    const sweeper = ctx.app.get(LicenseExpirySweeper);
    const affected = await sweeper.run();
    expect(affected).toBe(1);

    const pharmacyRow = await ctx.prisma.pharmacy.findUniqueOrThrow({
      where: { id: registered.pharmacyId as string },
    });
    expect(pharmacyRow.transactingStatus).toBe('SUSPENDED');
    expect(pharmacyRow.licenseStatus).toBe('EXPIRED');

    const auditCount = await ctx.prisma.auditLog.count({
      where: { action: 'PHARMACY_AUTO_SUSPENDED', resourceId: registered.pharmacyId as string },
    });
    expect(auditCount).toBe(1);
  });
});
