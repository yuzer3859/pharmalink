import request from 'supertest';
import { auth, body, errorOf, login, registerAndVerify } from '../support/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';

/**
 * Module 02 — Customer Profile (backend/docs/02-profiles-spec.md §8.1, §11, §16).
 */
describe('Profile — GET/PATCH /profile/me (e2e)', () => {
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

  it('AC-1: lazily creates an empty profile and returns it on first GET, never 404', async () => {
    const user = await registerAndVerify(ctx);
    const tokens = await login(ctx, user.phone, user.password);

    const res = await request(ctx.server)
      .get('/profile/me')
      .set(...auth(tokens.accessToken))
      .expect(200);

    expect(body(res)).toMatchObject({
      userId: user.userId,
      fullName: null,
      gender: null,
      dateOfBirth: null,
      secondaryPhone: null,
      timezone: 'Africa/Addis_Ababa',
    });

    // Exactly one CustomerProfile row for this user (event handler + GET safety-net upsert
    // must never duplicate — edge case 16.3).
    expect(await ctx.prisma.customerProfile.count({ where: { userId: user.userId } })).toBe(1);
  });

  it('AC-1: PATCH persists fullName and a subsequent GET reflects it', async () => {
    const user = await registerAndVerify(ctx);
    const tokens = await login(ctx, user.phone, user.password);

    const patch = await request(ctx.server)
      .patch('/profile/me')
      .set(...auth(tokens.accessToken))
      .send({ fullName: 'Abebe Kebede' })
      .expect(200);
    expect(body(patch).fullName).toBe('Abebe Kebede');

    const get = await request(ctx.server)
      .get('/profile/me')
      .set(...auth(tokens.accessToken))
      .expect(200);
    expect(body(get).fullName).toBe('Abebe Kebede');
  });

  it('persists each editable field individually and in combination', async () => {
    const user = await registerAndVerify(ctx);
    const tokens = await login(ctx, user.phone, user.password);

    const fields: Array<[string, unknown]> = [
      ['fullName', 'Sara Tesfaye'],
      ['gender', 'FEMALE'],
      ['dateOfBirth', '1995-05-20'],
      ['secondaryPhone', '0911223344'],
      ['timezone', 'Africa/Addis_Ababa'],
    ];
    for (const [key, value] of fields) {
      const res = await request(ctx.server)
        .patch('/profile/me')
        .set(...auth(tokens.accessToken))
        .send({ [key]: value })
        .expect(200);
      if (key === 'dateOfBirth') {
        expect(body(res).dateOfBirth).toBe('1995-05-20');
      } else if (key === 'secondaryPhone') {
        expect(body(res).secondaryPhone).toBe('+251911223344');
      } else {
        expect(body(res)[key]).toBe(value);
      }
    }

    const combined = await request(ctx.server)
      .patch('/profile/me')
      .set(...auth(tokens.accessToken))
      .send({ fullName: 'Combined Name', gender: 'MALE' })
      .expect(200);
    expect(body(combined)).toMatchObject({ fullName: 'Combined Name', gender: 'MALE' });
  });

  it('16.2: empty body -> 400 VALIDATION_ERROR ("at least one field")', async () => {
    const user = await registerAndVerify(ctx);
    const tokens = await login(ctx, user.phone, user.password);

    const res = await request(ctx.server)
      .patch('/profile/me')
      .set(...auth(tokens.accessToken))
      .send({})
      .expect(400);
    expect(errorOf(res).code).toBe('VALIDATION_ERROR');
    expect(errorOf(res).message).toMatch(/at least one field/i);
  });

  it('16.2: dateOfBirth in the future -> 400 VALIDATION_ERROR (application-layer check throws ' +
    'ProfileErrors.validation, which maps to 400 platform-wide, not 422 as the spec text says — ' +
    'see QA report deviation note)', async () => {
    const user = await registerAndVerify(ctx);
    const tokens = await login(ctx, user.phone, user.password);

    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const res = await request(ctx.server)
      .patch('/profile/me')
      .set(...auth(tokens.accessToken))
      .send({ dateOfBirth: tomorrow })
      .expect(400);
    expect(errorOf(res).code).toBe('VALIDATION_ERROR');
  });

  it('16.2: dateOfBirth implying age > 120 -> 400 VALIDATION_ERROR', async () => {
    const user = await registerAndVerify(ctx);
    const tokens = await login(ctx, user.phone, user.password);

    const res = await request(ctx.server)
      .patch('/profile/me')
      .set(...auth(tokens.accessToken))
      .send({ dateOfBirth: '1850-01-01' })
      .expect(400);
    expect(errorOf(res).code).toBe('VALIDATION_ERROR');
  });

  it('16.2: invalid gender enum -> 400 VALIDATION_ERROR', async () => {
    const user = await registerAndVerify(ctx);
    const tokens = await login(ctx, user.phone, user.password);

    const res = await request(ctx.server)
      .patch('/profile/me')
      .set(...auth(tokens.accessToken))
      .send({ gender: 'MAN' })
      .expect(400);
    expect(errorOf(res).code).toBe('VALIDATION_ERROR');
  });

  it('edge case 13: rejects photoUrl/preferredLanguage via forbidNonWhitelisted -> 400', async () => {
    const user = await registerAndVerify(ctx);
    const tokens = await login(ctx, user.phone, user.password);

    const res = await request(ctx.server)
      .patch('/profile/me')
      .set(...auth(tokens.accessToken))
      .send({ photoUrl: 'https://example.com/x.png' })
      .expect(400);
    expect(errorOf(res).code).toBe('VALIDATION_ERROR');

    const res2 = await request(ctx.server)
      .patch('/profile/me')
      .set(...auth(tokens.accessToken))
      .send({ preferredLanguage: 'am' })
      .expect(400);
    expect(errorOf(res2).code).toBe('VALIDATION_ERROR');
  });

  it('16.2: non-Ethiopian secondaryPhone -> 400 VALIDATION_ERROR', async () => {
    const user = await registerAndVerify(ctx);
    const tokens = await login(ctx, user.phone, user.password);

    const res = await request(ctx.server)
      .patch('/profile/me')
      .set(...auth(tokens.accessToken))
      .send({ secondaryPhone: '+15551234567' })
      .expect(400);
    expect(errorOf(res).code).toBe('VALIDATION_ERROR');
  });

  it('unauthenticated request -> 401 UNAUTHENTICATED', async () => {
    const res = await request(ctx.server).get('/profile/me').expect(401);
    expect(errorOf(res).code).toBe('UNAUTHENTICATED');
  });

  it('AC-6 / audit: PATCH writes exactly one hash-chained audit_logs row with field names only', async () => {
    const user = await registerAndVerify(ctx);
    const tokens = await login(ctx, user.phone, user.password);

    const before = await ctx.prisma.auditLog.count();
    await request(ctx.server)
      .patch('/profile/me')
      .set(...auth(tokens.accessToken))
      .send({ fullName: 'Secret Name', dateOfBirth: '1990-01-01', secondaryPhone: '0911223344' })
      .expect(200);

    const rows = await ctx.prisma.auditLog.findMany({
      where: { action: 'PROFILE_UPDATED' },
      orderBy: { createdAt: 'desc' },
    });
    expect(await ctx.prisma.auditLog.count()).toBe(before + 1);
    const entry = rows[0];
    expect(entry.actorUserId).toBe(user.userId);
    expect(entry.resourceType).toBe('CustomerProfile');
    expect(entry.hash).toBeTruthy();

    const context = JSON.stringify(entry.context);
    expect(context).not.toMatch(/Secret Name/);
    expect(context).not.toMatch(/1990-01-01/);
    expect(context).not.toMatch(/0911223344|251911223344/);
    expect((entry.context as { fields: string[] }).fields).toEqual(
      expect.arrayContaining(['fullName', 'dateOfBirth', 'secondaryPhone']),
    );
  });

  it('outbox: PATCH /profile/me emits a profiles.profile.updated outbox row', async () => {
    const user = await registerAndVerify(ctx);
    const tokens = await login(ctx, user.phone, user.password);

    await request(ctx.server)
      .patch('/profile/me')
      .set(...auth(tokens.accessToken))
      .send({ fullName: 'Outbox Test' })
      .expect(200);

    const rows = await ctx.prisma.outbox.findMany({ where: { eventType: 'profiles.profile.updated' } });
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0].aggregateType).toBe('CustomerProfile');
  });

  it('regression: Identity PATCH /users/me is unaffected by ProfilesModule registration', async () => {
    const user = await registerAndVerify(ctx);
    const tokens = await login(ctx, user.phone, user.password);

    const res = await request(ctx.server)
      .patch('/users/me')
      .set(...auth(tokens.accessToken))
      .send({ preferredLanguage: 'am' })
      .expect(200);
    expect(body(res).preferredLanguage).toBe('am');
  });
});
