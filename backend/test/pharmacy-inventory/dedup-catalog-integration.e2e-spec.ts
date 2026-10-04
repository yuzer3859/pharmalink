import request from 'supertest';
import { auth, body, createUserWithRole, errorOf, grantRoleDirect, login, registerAndVerify } from '../support/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';
import { createActivatedPharmacy, createPharmacyOrganization } from './support';

/**
 * Confirms the real (unmocked) `ICatalogPort`/`IIdentityPort` adapters work end-to-end against
 * genuine seeded Module 01/03 data — not test doubles (module-04 §18). Catches drift if Module
 * 01's `Organization` shape or Module 03's `Product` shape changes.
 */
describe('Pharmacy & Inventory — real cross-module port integration (e2e)', () => {
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

  it('rejects registration for a non-existent organizationId via the real IIdentityPort adapter', async () => {
    const owner = await registerAndVerify(ctx);
    await grantRoleDirect(ctx, owner.userId, 'PHARMACY_OWNER', null);
    const tokens = await login(ctx, owner.phone, owner.password);

    const res = await request(ctx.server)
      .post('/pharmacy/register')
      .set(...auth(tokens.accessToken))
      .send({ organizationId: '00000000-0000-0000-0000-000000000000', displayName: 'Ghost Pharmacy' });
    expect(res.status).toBe(404);
  });

  it('rejects registration when the caller is not the organization owner (real IIdentityPort.getOrganizationOwner)', async () => {
    const owner = await registerAndVerify(ctx);
    const { organizationId } = await createPharmacyOrganization(ctx, owner.userId);

    const impostor = await registerAndVerify(ctx);
    await grantRoleDirect(ctx, impostor.userId, 'PHARMACY_OWNER', organizationId);
    const impostorTokens = await login(ctx, impostor.phone, impostor.password);

    const res = await request(ctx.server)
      .post('/pharmacy/register')
      .set(...auth(impostorTokens.accessToken))
      .send({ organizationId, displayName: 'Stolen Pharmacy' });
    expect(res.status).toBe(403);
    expect(errorOf(res).code).toBe('FORBIDDEN');
  });

  it('rejects a listing referencing a catalog product that does not exist (real ICatalogPort adapter)', async () => {
    const pharmacy = await createActivatedPharmacy(ctx);
    const branch = body(
      await request(ctx.server)
        .post('/pharmacy/branches')
        .set(...auth(pharmacy.accessToken))
        .send({ name: 'Main Branch' })
        .expect(201),
    );

    const res = await request(ctx.server)
      .post('/inventory/listings')
      .set(...auth(pharmacy.accessToken))
      .send({
        catalogProductId: '00000000-0000-0000-0000-000000000000',
        branchId: branch.branchId,
        price: 500,
        batchNumber: 'B-1',
        initialQuantity: 5,
        expiryDate: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
      });
    expect(res.status).toBe(404);
    expect(errorOf(res).code).toBe('CATALOG_PRODUCT_NOT_FOUND');
  });

  it('rejects a listing referencing a DRAFT (not-yet-ACTIVE) catalog product', async () => {
    const pharmacy = await createActivatedPharmacy(ctx);
    const branch = body(
      await request(ctx.server)
        .post('/pharmacy/branches')
        .set(...auth(pharmacy.accessToken))
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
    const draftProduct = body(
      await request(ctx.server)
        .post('/admin/catalog/products')
        .set(...auth(admin.accessToken))
        .send({
          type: 'MEDICINE',
          genericName: 'Draft Med',
          manufacturerId: mfr.id,
          dosageForm: 'TABLET',
          strengthValue: 100,
          strengthUnit: 'MG',
          rxClassification: 'OTC',
          nameEn: 'Draft Med 100mg',
        })
        .expect(201),
    );

    const res = await request(ctx.server)
      .post('/inventory/listings')
      .set(...auth(pharmacy.accessToken))
      .send({
        catalogProductId: draftProduct.id,
        branchId: branch.branchId,
        price: 500,
        batchNumber: 'B-1',
        initialQuantity: 5,
        expiryDate: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
      });
    expect(res.status).toBe(404);
    expect(errorOf(res).code).toBe('CATALOG_PRODUCT_NOT_FOUND');
  });
});
