import request from 'supertest';
import { OtpPurpose } from '../../src/modules/identity/domain/enums';
import {
  auth,
  body,
  createUserWithRole,
  errorOf,
  login,
  registerAndVerify,
  uniquePhone,
} from '../support/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';

const ADDIS = { lat: 9.03, lng: 38.74 };

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

describe('Default-address invariant, concurrency, ownership & RBAC (e2e)', () => {
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

  // ---------------------------------------------------------------------------------------
  // AC-4 — default swap via POST /addresses/:id/default
  // ---------------------------------------------------------------------------------------
  it('AC-4: POST /addresses/:id/default swaps the default atomically', async () => {
    const user = await customer();
    const a = body(
      await request(ctx.server).post('/addresses').set(...auth(user.accessToken)).send(baseAddress()).expect(201),
    );
    const b = body(
      await request(ctx.server)
        .post('/addresses')
        .set(...auth(user.accessToken))
        .send(baseAddress({ recipientName: 'B B' }))
        .expect(201),
    );
    expect(a.isDefault).toBe(true);
    expect(b.isDefault).toBe(false);

    // DEFECT (module-02 §8.2 documents 200 for this endpoint; the controller has no
    // @HttpCode override so Nest's POST default of 201 is returned instead) — see QA report.
    await request(ctx.server)
      .post(`/addresses/${b.id}/default`)
      .set(...auth(user.accessToken))
      .expect(201);

    const list = body(
      await request(ctx.server).get('/addresses').set(...auth(user.accessToken)).expect(200),
    ) as unknown as Array<{ id: string; isDefault: boolean }>;
    expect(list.find((x) => x.id === a.id)!.isDefault).toBe(false);
    expect(list.find((x) => x.id === b.id)!.isDefault).toBe(true);

    // The DB must never have transiently persisted two defaults for this user.
    const defaults = await ctx.prisma.address.count({
      where: { userId: user.userId, isDefault: true, deletedAt: null },
    });
    expect(defaults).toBe(1);
  });

  it('16.3 / edge case 8: two concurrent set-default requests for two currently-NON-default ' +
    'addresses both get defined, non-500 responses and leave exactly one default ' +
    '(DEFECT-PROFILES-001 fixed — the losing transaction retries against the new state)', async () => {
    const user = await customer();
    // A is auto-default on creation; B and C are both non-default — the genuine race is between
    // B and C (racing "already the default" against something else is a no-op, not a race).
    await request(ctx.server).post('/addresses').set(...auth(user.accessToken)).send(baseAddress()).expect(201);
    const b = body(
      await request(ctx.server)
        .post('/addresses')
        .set(...auth(user.accessToken))
        .send(baseAddress({ recipientName: 'B B' }))
        .expect(201),
    );
    const c = body(
      await request(ctx.server)
        .post('/addresses')
        .set(...auth(user.accessToken))
        .send(baseAddress({ recipientName: 'C C' }))
        .expect(201),
    );
    expect(b.isDefault).toBe(false);
    expect(c.isDefault).toBe(false);

    const [resB, resC] = await Promise.all([
      request(ctx.server).post(`/addresses/${b.id}/default`).set(...auth(user.accessToken)),
      request(ctx.server).post(`/addresses/${c.id}/default`).set(...auth(user.accessToken)),
    ]);

    // DEFECT-PROFILES-001 fix (module-02 §6.3, edge case 8): the addresses_one_default_per_user
    // partial index still lets only one commit win, but the loser now re-evaluates against the
    // committed state and retries rather than surfacing a 500. Both callers therefore get a
    // defined API response and NEITHER is a 500 INTERNAL_ERROR.
    expect(resB.status).not.toBe(500);
    expect(resC.status).not.toBe(500);
    // Every route in this slice returns the standard envelope; both are defined 2xx successes
    // (POST default status is 201 — see the AC-4 test's note on the missing @HttpCode override).
    expect(resB.status).toBe(201);
    expect(resC.status).toBe(201);

    // The DB constraint (§6.3 partial unique index) must never be violated: exactly one default,
    // regardless of which of the two concurrent callers committed last.
    const defaults = await ctx.prisma.address.findMany({
      where: { userId: user.userId, isDefault: true, deletedAt: null },
      select: { id: true },
    });
    expect(defaults).toHaveLength(1);
    // The winning default is one of the two contenders (never address A, and never a phantom).
    expect([b.id, c.id]).toContain(defaults[0].id);
  });

  it('16.3: concurrent GET /profile/me for a freshly registered user never duplicates the profile row', async () => {
    const phone = uniquePhone();
    const registration = await request(ctx.server).post('/auth/register').send({ phone, password: 'Str0ngPassw0rd' }).expect(201);
    await ctx.drainOutbox();
    const code = ctx.notifications.lastCodeFor(phone, 'otp-register');
    await request(ctx.server)
      .post('/auth/verify-otp')
      .send({ identifier: phone, code, purpose: OtpPurpose.REGISTER })
      .expect(201);
    const tokens = await login(ctx, phone, 'Str0ngPassw0rd');
    const userId = body(registration).userId as string;

    const [r1, r2] = await Promise.all([
      request(ctx.server).get('/profile/me').set(...auth(tokens.accessToken)),
      request(ctx.server).get('/profile/me').set(...auth(tokens.accessToken)),
    ]);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(await ctx.prisma.customerProfile.count({ where: { userId } })).toBe(1);
  });

  it('UserRegistered -> CustomerProfile row is created via the event handler within a bounded delay', async () => {
    const phone = uniquePhone();
    const registration = await request(ctx.server).post('/auth/register').send({ phone, password: 'Str0ngPassw0rd' }).expect(201);
    const userId = body(registration).userId as string;

    // Registration only writes the outbox row; the relay triggers delivery/handlers.
    await ctx.drainOutbox();

    const profile = await ctx.prisma.customerProfile.findUnique({ where: { userId } });
    expect(profile).toBeTruthy();
    expect(profile!.fullName).toBeNull();
  });

  // ---------------------------------------------------------------------------------------
  // AC-5 / §7.3 — ownership isolation (no existence leakage)
  // ---------------------------------------------------------------------------------------
  it('AC-5: a different customer gets 404 (not 403/200) on GET of someone else\'s address', async () => {
    const owner = await customer();
    const other = await customer();
    const address = body(
      await request(ctx.server).post('/addresses').set(...auth(owner.accessToken)).send(baseAddress()).expect(201),
    );

    const res = await request(ctx.server)
      .get(`/addresses/${address.id}`)
      .set(...auth(other.accessToken))
      .expect(404);
    expect(errorOf(res).code).toBe('NOT_FOUND');
  });

  it('16.4: ownership is enforced identically for PATCH, DELETE, and POST .../default', async () => {
    const owner = await customer();
    const other = await customer();
    const address = body(
      await request(ctx.server).post('/addresses').set(...auth(owner.accessToken)).send(baseAddress()).expect(201),
    );

    const patchRes = await request(ctx.server)
      .patch(`/addresses/${address.id}`)
      .set(...auth(other.accessToken))
      .send({ recipientName: 'Hijacked' })
      .expect(404);
    expect(errorOf(patchRes).code).toBe('NOT_FOUND');

    const defaultRes = await request(ctx.server)
      .post(`/addresses/${address.id}/default`)
      .set(...auth(other.accessToken))
      .expect(404);
    expect(errorOf(defaultRes).code).toBe('NOT_FOUND');

    const deleteRes = await request(ctx.server)
      .delete(`/addresses/${address.id}`)
      .set(...auth(other.accessToken))
      .expect(404);
    expect(errorOf(deleteRes).code).toBe('NOT_FOUND');

    // Confirm it is untouched by the non-owner's attempts.
    const stillThere = await request(ctx.server)
      .get(`/addresses/${address.id}`)
      .set(...auth(owner.accessToken))
      .expect(200);
    expect(body(stillThere).recipientName).toBe('Abebe Kebede');
  });

  // ---------------------------------------------------------------------------------------
  // §16.4 — security / access control
  // ---------------------------------------------------------------------------------------
  it('unauthenticated requests to every address route -> 401 UNAUTHENTICATED', async () => {
    // Built lazily (not as already-in-flight supertest.Test objects) and separated by a tick —
    // firing several ephemeral-listener requests back-to-back against the same in-process
    // server has been observed to trip a transient ECONNREFUSED on Windows test runners.
    const requests: Array<() => request.Test> = [
      () => request(ctx.server).get('/addresses'),
      () => request(ctx.server).get('/addresses/some-id'),
      () => request(ctx.server).post('/addresses').send(baseAddress()),
      () => request(ctx.server).patch('/addresses/some-id').send({ recipientName: 'x' }),
      () => request(ctx.server).delete('/addresses/some-id'),
      () => request(ctx.server).post('/addresses/some-id/default'),
    ];
    for (const makeReq of requests) {
      const res = await makeReq().expect(401);
      expect(errorOf(res).code).toBe('UNAUTHENTICATED');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  });

  /**
   * NOTE: self-registration always assigns CUSTOMER as the primary role (register-user.command.ts),
   * and CUSTOMER carries address:read:own/address:manage:own (§7.2 — customer-only for this
   * slice). `createUserWithRole` only *adds* a role on top of that, so a driver/doctor/etc.
   * "additionally" registered still passes the guard via their CUSTOMER grant. To exercise a
   * genuinely permission-less principal we strip the CUSTOMER assignment directly (there is no
   * public "remove my own role" endpoint), then re-login so the token's embedded permission set
   * reflects DRIVER only.
   */
  async function driverWithoutCustomerRole() {
    const user = await createUserWithRole(ctx, 'DRIVER');
    const customerRole = await ctx.prisma.role.findUniqueOrThrow({ where: { key: 'CUSTOMER' } });
    await ctx.prisma.userRole.deleteMany({ where: { userId: user.userId, roleId: customerRole.id } });
    const tokens = await login(ctx, user.phone, user.password);
    return { ...user, ...tokens };
  }

  it('16.4: a role without address:manage:own gets 403 FORBIDDEN on POST /addresses', async () => {
    const driver = await driverWithoutCustomerRole();
    const res = await request(ctx.server)
      .post('/addresses')
      .set(...auth(driver.accessToken))
      .send(baseAddress())
      .expect(403);
    expect(errorOf(res).code).toBe('FORBIDDEN');
  });

  it('16.4: a role without address:read:own gets 403 FORBIDDEN on GET /addresses', async () => {
    const driver = await driverWithoutCustomerRole();
    const res = await request(ctx.server)
      .get('/addresses')
      .set(...auth(driver.accessToken))
      .expect(403);
    expect(errorOf(res).code).toBe('FORBIDDEN');
  });

  it('audit: ADDRESS_DEFAULT_CHANGED is recorded on POST /addresses/:id/default', async () => {
    const user = await customer();
    const a = body(
      await request(ctx.server).post('/addresses').set(...auth(user.accessToken)).send(baseAddress()).expect(201),
    );
    const b = body(
      await request(ctx.server)
        .post('/addresses')
        .set(...auth(user.accessToken))
        .send(baseAddress({ recipientName: 'B B' }))
        .expect(201),
    );

    await request(ctx.server)
      .post(`/addresses/${b.id}/default`)
      .set(...auth(user.accessToken))
      .expect(201);

    const entry = await ctx.prisma.auditLog.findFirst({
      where: { action: 'ADDRESS_DEFAULT_CHANGED', resourceId: b.id as string },
    });
    expect(entry).toBeTruthy();
    expect((entry!.context as { previousAddressId: string }).previousAddressId).toBe(a.id);
  });
});
