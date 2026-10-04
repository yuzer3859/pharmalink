import request from 'supertest';
import { auth, body, createUserWithRole } from '../support/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';

describe('Catalog — medicine dedup concurrency (e2e, §6.2/§11 edge case 5)', () => {
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

  it('exactly one of two concurrent identical-medicine creates succeeds; the other gets 409, never a 500', async () => {
    const admin = await createUserWithRole(ctx, 'ADMIN');
    const mfr = body(
      await request(ctx.server)
        .post('/admin/catalog/manufacturers')
        .set(...auth(admin.accessToken))
        .send({ name: 'Acme Pharma' })
        .expect(201),
    );

    const dto = {
      type: 'MEDICINE',
      genericName: 'Ibuprofen',
      manufacturerId: mfr.id,
      dosageForm: 'TABLET',
      strengthValue: 200,
      strengthUnit: 'MG',
      rxClassification: 'OTC',
      nameEn: 'Ibuprofen 200mg',
    };

    const [a, b] = await Promise.all([
      request(ctx.server).post('/admin/catalog/products').set(...auth(admin.accessToken)).send(dto),
      request(ctx.server).post('/admin/catalog/products').set(...auth(admin.accessToken)).send(dto),
    ]);

    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([201, 409]);

    const count = await ctx.prisma.product.count({ where: { genericName: 'Ibuprofen', deletedAt: null } });
    expect(count).toBe(1);
  });
});
