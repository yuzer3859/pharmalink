import request from 'supertest';
import { auth, body, errorOf, login, registerAndVerify } from '../support/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';

/** A valid Addis Ababa coordinate, well inside the ET bounding box (module-02 §5). */
const ADDIS = { lat: 9.03, lng: 38.74 };
/** A coordinate outside Ethiopia (Djibouti-ish / far outside the box). */
const OUTSIDE = { lat: 1.0, lng: 20.0 };

function baseAddress(overrides: Record<string, unknown> = {}) {
  return {
    recipientName: 'Abebe Kebede',
    recipientPhone: '0911223344',
    region: 'Addis Ababa',
    city: 'Addis Ababa',
    addressLine: 'Bole Road, near the airport',
    lat: ADDIS.lat,
    lng: ADDIS.lng,
    ...overrides,
  };
}

describe('Address CRUD — /addresses (e2e)', () => {
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

  async function customer() {
    const user = await registerAndVerify(ctx);
    const tokens = await login(ctx, user.phone, user.password);
    return { ...user, ...tokens };
  }

  it('AC-2: first address is auto-marked default (201)', async () => {
    const user = await customer();
    const res = await request(ctx.server)
      .post('/addresses')
      .set(...auth(user.accessToken))
      .send(baseAddress())
      .expect(201);
    expect(body(res)).toMatchObject({ isDefault: true, label: 'HOME' });
  });

  it('a second address created with isDefault:true flips the first to false', async () => {
    const user = await customer();
    const first = body(
      await request(ctx.server)
        .post('/addresses')
        .set(...auth(user.accessToken))
        .send(baseAddress())
        .expect(201),
    );
    const second = body(
      await request(ctx.server)
        .post('/addresses')
        .set(...auth(user.accessToken))
        .send(baseAddress({ isDefault: true, recipientName: 'Second Recipient' }))
        .expect(201),
    );
    expect(second.isDefault).toBe(true);

    const list = body(
      await request(ctx.server).get('/addresses').set(...auth(user.accessToken)).expect(200),
    ) as unknown as Array<{ id: string; isDefault: boolean }>;
    expect(list.find((a) => a.id === first.id)!.isDefault).toBe(false);
    expect(list.find((a) => a.id === second.id)!.isDefault).toBe(true);
  });

  it('GET /addresses orders isDefault desc, updatedAt desc', async () => {
    const user = await customer();
    await request(ctx.server).post('/addresses').set(...auth(user.accessToken)).send(baseAddress()).expect(201);
    await request(ctx.server)
      .post('/addresses')
      .set(...auth(user.accessToken))
      .send(baseAddress({ recipientName: 'Second' }))
      .expect(201);

    const list = body(
      await request(ctx.server).get('/addresses').set(...auth(user.accessToken)).expect(200),
    ) as unknown as Array<{ isDefault: boolean }>;
    expect(list[0].isDefault).toBe(true);
  });

  it('PATCH updates lat/lng to a still-valid ET point', async () => {
    const user = await customer();
    const created = body(
      await request(ctx.server)
        .post('/addresses')
        .set(...auth(user.accessToken))
        .send(baseAddress())
        .expect(201),
    );

    const patched = await request(ctx.server)
      .patch(`/addresses/${created.id}`)
      .set(...auth(user.accessToken))
      .send({ lat: 9.05, lng: 38.76 })
      .expect(200);
    expect(body(patched)).toMatchObject({ lat: 9.05, lng: 38.76 });
  });

  it('PATCH re-validates the geofence when lat/lng change -> 422 if now outside ET', async () => {
    const user = await customer();
    const created = body(
      await request(ctx.server)
        .post('/addresses')
        .set(...auth(user.accessToken))
        .send(baseAddress())
        .expect(201),
    );

    const res = await request(ctx.server)
      .patch(`/addresses/${created.id}`)
      .set(...auth(user.accessToken))
      .send(OUTSIDE)
      .expect(422);
    expect(errorOf(res).code).toBe('ADDRESS_OUTSIDE_ETHIOPIA');

    // Original coordinates must be untouched.
    const get = await request(ctx.server)
      .get(`/addresses/${created.id}`)
      .set(...auth(user.accessToken))
      .expect(200);
    expect(body(get)).toMatchObject(ADDIS);
  });

  it('DELETE a non-default address leaves the others unaffected (204)', async () => {
    const user = await customer();
    const first = body(
      await request(ctx.server).post('/addresses').set(...auth(user.accessToken)).send(baseAddress()).expect(201),
    );
    const second = body(
      await request(ctx.server)
        .post('/addresses')
        .set(...auth(user.accessToken))
        .send(baseAddress({ recipientName: 'Second' }))
        .expect(201),
    );

    await request(ctx.server)
      .delete(`/addresses/${second.id}`)
      .set(...auth(user.accessToken))
      .expect(204);

    const list = body(
      await request(ctx.server).get('/addresses').set(...auth(user.accessToken)).expect(200),
    ) as unknown as Array<{ id: string }>;
    expect(list.map((a) => a.id)).toEqual([first.id]);
  });

  it('DELETE the default address with another remaining promotes the remaining one to default', async () => {
    const user = await customer();
    const first = body(
      await request(ctx.server).post('/addresses').set(...auth(user.accessToken)).send(baseAddress()).expect(201),
    );
    const second = body(
      await request(ctx.server)
        .post('/addresses')
        .set(...auth(user.accessToken))
        .send(baseAddress({ recipientName: 'Second' }))
        .expect(201),
    );
    expect(first.isDefault).toBe(true);
    expect(second.isDefault).toBe(false);

    await request(ctx.server)
      .delete(`/addresses/${first.id}`)
      .set(...auth(user.accessToken))
      .expect(204);

    const remaining = await request(ctx.server)
      .get(`/addresses/${second.id}`)
      .set(...auth(user.accessToken))
      .expect(200);
    expect(body(remaining).isDefault).toBe(true);
  });

  it('edge case 9: deleting the only address succeeds, leaving zero addresses / no default', async () => {
    const user = await customer();
    const only = body(
      await request(ctx.server).post('/addresses').set(...auth(user.accessToken)).send(baseAddress()).expect(201),
    );

    await request(ctx.server)
      .delete(`/addresses/${only.id}`)
      .set(...auth(user.accessToken))
      .expect(204);

    const list = body(
      await request(ctx.server).get('/addresses').set(...auth(user.accessToken)).expect(200),
    ) as unknown as unknown[];
    expect(list).toHaveLength(0);
  });

  it('audit: ADDRESS_ADDED / ADDRESS_UPDATED / ADDRESS_REMOVED are recorded with non-sensitive context only', async () => {
    const user = await customer();
    const created = body(
      await request(ctx.server).post('/addresses').set(...auth(user.accessToken)).send(baseAddress()).expect(201),
    );

    const addressId = created.id as string;
    const addEntry = await ctx.prisma.auditLog.findFirst({
      where: { action: 'ADDRESS_ADDED', resourceId: addressId },
    });
    expect(addEntry).toBeTruthy();
    expect(JSON.stringify(addEntry!.context)).not.toMatch(/Abebe Kebede|0911223344|251911223344/);

    await request(ctx.server)
      .patch(`/addresses/${addressId}`)
      .set(...auth(user.accessToken))
      .send({ recipientName: 'Changed Name' })
      .expect(200);
    const updateEntry = await ctx.prisma.auditLog.findFirst({
      where: { action: 'ADDRESS_UPDATED', resourceId: addressId },
    });
    expect(JSON.stringify(updateEntry!.context)).not.toMatch(/Changed Name/);
    expect((updateEntry!.context as { fields: string[] }).fields).toContain('recipientName');

    await request(ctx.server)
      .delete(`/addresses/${addressId}`)
      .set(...auth(user.accessToken))
      .expect(204);
    const removeEntry = await ctx.prisma.auditLog.findFirst({
      where: { action: 'ADDRESS_REMOVED', resourceId: addressId },
    });
    expect(removeEntry).toBeTruthy();
    expect((removeEntry!.context as { wasDefault: boolean }).wasDefault).toBe(true);
  });

  it('outbox: address mutations emit the documented event types', async () => {
    const user = await customer();
    const created = body(
      await request(ctx.server).post('/addresses').set(...auth(user.accessToken)).send(baseAddress()).expect(201),
    );
    const addressId = created.id as string;
    await request(ctx.server)
      .patch(`/addresses/${addressId}`)
      .set(...auth(user.accessToken))
      .send({ landmark: 'Near the big mosque' })
      .expect(200);
    await request(ctx.server)
      .delete(`/addresses/${addressId}`)
      .set(...auth(user.accessToken))
      .expect(204);

    const types = (await ctx.prisma.outbox.findMany({ where: { aggregateId: addressId } })).map(
      (r) => r.eventType,
    );
    expect(types).toEqual(
      expect.arrayContaining(['profiles.address.added', 'profiles.address.updated', 'profiles.address.removed']),
    );
  });
});
