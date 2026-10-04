import request from 'supertest';
import { auth, body, errorOf, login, registerAndVerify } from '../support/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';

const ADDIS = { lat: 9.03, lng: 38.74 };
const OUTSIDE = { lat: 1.0, lng: 20.0 };

function baseAddress(overrides: Record<string, unknown> = {}) {
  return {
    recipientName: 'Abebe Kebede',
    recipientPhone: '0911223344',
    region: 'Addis Ababa',
    city: 'Addis Ababa',
    addressLine: 'Bole Road',
    lat: ADDIS.lat,
    lng: ADDIS.lng,
    ...overrides,
  };
}

describe('Address validation & business rules — /addresses (e2e)', () => {
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

  it('AC-3: coordinates outside Ethiopia -> 422 ADDRESS_OUTSIDE_ETHIOPIA, nothing persisted', async () => {
    const user = await customer();
    const res = await request(ctx.server)
      .post('/addresses')
      .set(...auth(user.accessToken))
      .send(baseAddress(OUTSIDE))
      .expect(422);
    expect(errorOf(res).code).toBe('ADDRESS_OUTSIDE_ETHIOPIA');
    expect(await ctx.prisma.address.count({ where: { userId: user.userId } })).toBe(0);
  });

  it('16.2: 21st address for one user -> 422 ADDRESS_LIMIT_REACHED', async () => {
    const user = await customer();
    for (let i = 0; i < 20; i += 1) {
      await request(ctx.server)
        .post('/addresses')
        .set(...auth(user.accessToken))
        .send(baseAddress({ recipientName: `Recipient ${i}` }))
        .expect(201);
    }
    const res = await request(ctx.server)
      .post('/addresses')
      .set(...auth(user.accessToken))
      .send(baseAddress({ recipientName: 'Recipient 21' }))
      .expect(422);
    expect(errorOf(res).code).toBe('ADDRESS_LIMIT_REACHED');
    expect(await ctx.prisma.address.count({ where: { userId: user.userId, deletedAt: null } })).toBe(20);
  }, 60_000);

  it('counter-check: soft-deleted addresses do not count toward the 20-address cap', async () => {
    const user = await customer();
    const created: string[] = [];
    for (let i = 0; i < 20; i += 1) {
      const res = await request(ctx.server)
        .post('/addresses')
        .set(...auth(user.accessToken))
        .send(baseAddress({ recipientName: `Recipient ${i}` }))
        .expect(201);
      created.push(body(res).id as string);
    }
    // Full at 20.
    await request(ctx.server)
      .post('/addresses')
      .set(...auth(user.accessToken))
      .send(baseAddress({ recipientName: 'Overflow' }))
      .expect(422);

    // Delete one — soft delete should free up a slot.
    await request(ctx.server)
      .delete(`/addresses/${created[0]}`)
      .set(...auth(user.accessToken))
      .expect(204);

    await request(ctx.server)
      .post('/addresses')
      .set(...auth(user.accessToken))
      .send(baseAddress({ recipientName: 'Fits now' }))
      .expect(201);
  }, 60_000);

  it('16.2: missing recipientPhone -> 400 VALIDATION_ERROR', async () => {
    const user = await customer();
    const { recipientPhone, ...rest } = baseAddress();
    const res = await request(ctx.server)
      .post('/addresses')
      .set(...auth(user.accessToken))
      .send(rest)
      .expect(400);
    expect(errorOf(res).code).toBe('VALIDATION_ERROR');
  });

  it('16.2: non-Ethiopian recipientPhone -> 400 VALIDATION_ERROR (application-layer PhoneNumber check; ' +
    'the spec text says 422 for this, but the platform-wide VALIDATION_ERROR->HTTP mapping is 400, ' +
    'consistent with Module 01 — see QA report deviation note)', async () => {
    const user = await customer();
    const res = await request(ctx.server)
      .post('/addresses')
      .set(...auth(user.accessToken))
      .send(baseAddress({ recipientPhone: '+15551234567' }))
      .expect(400);
    expect(errorOf(res).code).toBe('VALIDATION_ERROR');
  });

  it('16.2: lat out of [-90,90] -> 400 VALIDATION_ERROR', async () => {
    const user = await customer();
    const res = await request(ctx.server)
      .post('/addresses')
      .set(...auth(user.accessToken))
      .send(baseAddress({ lat: 95 }))
      .expect(400);
    expect(errorOf(res).code).toBe('VALIDATION_ERROR');
  });

  it('edge case 14: extraneous beneficiaryId field -> 400 VALIDATION_ERROR (forbidNonWhitelisted)', async () => {
    const user = await customer();
    const res = await request(ctx.server)
      .post('/addresses')
      .set(...auth(user.accessToken))
      .send(baseAddress({ beneficiaryId: 'some-id' }))
      .expect(400);
    expect(errorOf(res).code).toBe('VALIDATION_ERROR');
    expect(await ctx.prisma.address.count({ where: { userId: user.userId } })).toBe(0);
  });

  it('16.2 / "at least one locator": only landmark set -> 400 VALIDATION_ERROR field addressLine', async () => {
    const user = await customer();
    const res = await request(ctx.server)
      .post('/addresses')
      .set(...auth(user.accessToken))
      .send({
        recipientName: 'Abebe Kebede',
        recipientPhone: '0911223344',
        landmark: 'Near the big mosque',
        lat: ADDIS.lat,
        lng: ADDIS.lng,
      })
      .expect(400);
    expect(errorOf(res).code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details?.field).toBe('addressLine');
  });

  it('locator rule: region+city without addressLine is sufficient', async () => {
    const user = await customer();
    await request(ctx.server)
      .post('/addresses')
      .set(...auth(user.accessToken))
      .send({
        recipientName: 'Abebe Kebede',
        recipientPhone: '0911223344',
        region: 'Addis Ababa',
        city: 'Addis Ababa',
        lat: ADDIS.lat,
        lng: ADDIS.lng,
      })
      .expect(201);
  });

  it('locator rule: addressLine alone (no region/city) is sufficient', async () => {
    const user = await customer();
    await request(ctx.server)
      .post('/addresses')
      .set(...auth(user.accessToken))
      .send({
        recipientName: 'Abebe Kebede',
        recipientPhone: '0911223344',
        addressLine: 'Bole Road, house 12',
        lat: ADDIS.lat,
        lng: ADDIS.lng,
      })
      .expect(201);
  });

  it('16.2: PATCH {isDefault:false} on the sole/default address -> 422 DEFAULT_ADDRESS_REQUIRED', async () => {
    const user = await customer();
    const only = body(
      await request(ctx.server).post('/addresses').set(...auth(user.accessToken)).send(baseAddress()).expect(201),
    );

    const res = await request(ctx.server)
      .patch(`/addresses/${only.id}`)
      .set(...auth(user.accessToken))
      .send({ isDefault: false })
      .expect(422);
    expect(errorOf(res).code).toBe('DEFAULT_ADDRESS_REQUIRED');

    // Still default afterward — the rejected mutation must not have partially applied.
    const get = await request(ctx.server)
      .get(`/addresses/${only.id}`)
      .set(...auth(user.accessToken))
      .expect(200);
    expect(body(get).isDefault).toBe(true);
  });

  it('PATCH with empty body -> 400 VALIDATION_ERROR', async () => {
    const user = await customer();
    const only = body(
      await request(ctx.server).post('/addresses').set(...auth(user.accessToken)).send(baseAddress()).expect(201),
    );
    const res = await request(ctx.server)
      .patch(`/addresses/${only.id}`)
      .set(...auth(user.accessToken))
      .send({})
      .expect(400);
    expect(errorOf(res).code).toBe('VALIDATION_ERROR');
  });
});
