import request from 'supertest';
import { auth, body, createUserWithRole } from '../support/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';

describe('Catalog — Manufacturer CRUD (e2e)', () => {
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

  async function admin() {
    return createUserWithRole(ctx, 'ADMIN');
  }

  it('creates and lists a manufacturer', async () => {
    const a = await admin();
    await request(ctx.server)
      .post('/admin/catalog/manufacturers')
      .set(...auth(a.accessToken))
      .send({ name: 'Acme Pharma', country: 'Ethiopia' })
      .expect(201);

    const list = body(
      await request(ctx.server).get('/admin/catalog/manufacturers').set(...auth(a.accessToken)).expect(200),
    ) as unknown as Array<{ name: string }>;
    expect(list.some((m) => m.name === 'Acme Pharma')).toBe(true);
  });

  it('rejects a duplicate manufacturer name (generic 409 CONFLICT)', async () => {
    const a = await admin();
    await request(ctx.server)
      .post('/admin/catalog/manufacturers')
      .set(...auth(a.accessToken))
      .send({ name: 'Acme Pharma' })
      .expect(201);

    const dup = await request(ctx.server)
      .post('/admin/catalog/manufacturers')
      .set(...auth(a.accessToken))
      .send({ name: 'Acme Pharma' });
    expect(dup.status).toBe(409);
  });

  it('updates a manufacturer to INACTIVE instead of deleting it (no hard delete)', async () => {
    const a = await admin();
    const created = body(
      await request(ctx.server)
        .post('/admin/catalog/manufacturers')
        .set(...auth(a.accessToken))
        .send({ name: 'Acme Pharma' })
        .expect(201),
    );

    const updated = await request(ctx.server)
      .patch(`/admin/catalog/manufacturers/${created.id}`)
      .set(...auth(a.accessToken))
      .send({ status: 'INACTIVE' })
      .expect(200);
    expect(body(updated).status).toBe('INACTIVE');
  });
});
