import { randomUUID } from 'crypto';
import request from 'supertest';
import { ConfigOverrideLoader } from '../../src/modules/admin/infrastructure/config/config-override.loader';
import { ErrorCode } from '../../src/shared/errors/error-codes';
import { auth, body, createUserWithRole, errorOf, RegisteredUser, Tokens } from '../support/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';

/**
 * Work 85: support "view as" (module-16 F-AD-08) over the real HTTP stack, guard, audit chain,
 * outbox and notifications: ask → a second administrator approves → the asker starts it → a
 * 15-minute, read-only token for the account, refused for every write, audited per request.
 */
describe('Support impersonation (e2e)', () => {
  let ctx: TestContext;
  let loader: ConfigOverrideLoader;
  let maker: RegisteredUser & Tokens;
  let checker: RegisteredUser & Tokens;
  let finance: RegisteredUser & Tokens;
  let target: RegisteredUser & Tokens;

  beforeAll(async () => {
    ctx = await createTestApp();
    loader = ctx.app.get(ConfigOverrideLoader);
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  beforeEach(async () => {
    await ctx.reset();
    await loader.refresh();
    maker = await createUserWithRole(ctx, 'ADMIN');
    checker = await createUserWithRole(ctx, 'ADMIN');
    finance = await createUserWithRole(ctx, 'FINANCE_OFFICER');
    target = await createUserWithRole(ctx, 'CUSTOMER');
  });

  const ask = (token: string, userId: string, payload: object = { reason: 'Customer cannot see their order' }, key: string | null = randomUUID()) => {
    const r = request(ctx.server).post(`/admin/accounts/${userId}/impersonate`).set(...auth(token));
    return (key ? r.set('Idempotency-Key', key) : r).send(payload);
  };
  const decide = (token: string, approvalId: string, decision = 'APPROVE') =>
    request(ctx.server).post(`/admin/approvals/${approvalId}/decide`).set(...auth(token)).send({ decision });
  const start = (token: string, sessionId: string) =>
    request(ctx.server).post(`/admin/impersonation-sessions/${sessionId}/start`).set(...auth(token));

  /** Ask, approve, and return the authorized session id. */
  async function approvedSession(): Promise<string> {
    const asked = await ask(maker.accessToken, target.userId).expect(202);
    const done = body(await decide(checker.accessToken, (body(asked).approval as { id: string }).id).expect(200));
    return (done.executionResult as { sessionId: string }).sessionId;
  }

  it('refuses callers without support:impersonate:any (403) and validates the request (400)', async () => {
    await ask(finance.accessToken, target.userId).expect(403);
    await ask(target.accessToken, maker.userId).expect(403);
    expect(errorOf(await ask(maker.accessToken, target.userId, {}).expect(400)).code).toBe(ErrorCode.VALIDATION_ERROR);
    await ask(maker.accessToken, target.userId, { reason: 'Help' }, null).expect(400);
    await ask(maker.accessToken, randomUUID()).expect(404);
  });

  it('never impersonates a platform account or oneself', async () => {
    for (const userId of [checker.userId, finance.userId, maker.userId]) {
      expect(errorOf(await ask(maker.accessToken, userId).expect(403)).code).toBe(ErrorCode.IMPERSONATION_NOT_ALLOWED);
    }
    expect(await ctx.prisma.approvalRequest.count()).toBe(0);
  });

  it('needs a second administrator, and only the asker may start it', async () => {
    const asked = await ask(maker.accessToken, target.userId).expect(202);
    const approvalId = (body(asked).approval as { id: string }).id;
    expect(errorOf(await decide(maker.accessToken, approvalId).expect(403)).code).toBe(ErrorCode.MAKER_CHECKER_SELF_APPROVAL);
    const done = body(await decide(checker.accessToken, approvalId).expect(200));
    const sessionId = (done.executionResult as { sessionId: string }).sessionId;
    expect(done.executionResult).toMatchObject({ status: 'AUTHORIZED' });

    expect(errorOf(await start(checker.accessToken, sessionId).expect(403)).code).toBe(ErrorCode.IMPERSONATION_NOT_ALLOWED);
    await start(maker.accessToken, sessionId).expect(200);
    expect(errorOf(await start(maker.accessToken, sessionId).expect(409)).code).toBe(ErrorCode.IMPERSONATION_SESSION_CLOSED);
  });

  it('gives a read-only token for the account: reads work and are audited, every write is refused', async () => {
    const sessionId = await approvedSession();
    const token = body(await start(maker.accessToken, sessionId).expect(200)).accessToken as string;

    const me = body(await request(ctx.server).get('/users/me').set(...auth(token)).expect(200));
    expect(me.id).toBe(target.userId);

    const write = await request(ctx.server).patch('/users/me').set(...auth(token)).send({ preferredLanguage: 'am' });
    expect(write.status).toBe(403);
    expect(errorOf(write).code).toBe(ErrorCode.IMPERSONATION_READ_ONLY);
    await request(ctx.server).post('/auth/logout').set(...auth(token)).send({}).expect(403);

    const audited = await ctx.prisma.auditLog.findMany({ where: { action: 'IMPERSONATED_REQUEST', resourceId: sessionId } });
    expect(audited).toHaveLength(1);
    expect(audited[0]).toMatchObject({ actorUserId: maker.userId });
    expect(audited[0].context).toMatchObject({ targetUserId: target.userId, method: 'GET', path: '/users/me' });
    expect(
      (await ctx.prisma.auditLog.findMany({ where: { resourceId: sessionId }, orderBy: { createdAt: 'asc' } })).map((a) => a.action),
    ).toEqual(['IMPERSONATION_AUTHORIZED', 'IMPERSONATION_STARTED', 'IMPERSONATED_REQUEST']);
  });

  it('tells the account holder, and ending the session revokes the token at once', async () => {
    const sessionId = await approvedSession();
    const token = body(await start(maker.accessToken, sessionId).expect(200)).accessToken as string;
    expect(await ctx.prisma.outbox.count({ where: { eventType: 'identity.impersonation.started' } })).toBe(1);
    await ctx.drainOutbox();
    const notice = await ctx.prisma.notification.findFirstOrThrow({
      where: { recipientUserId: target.userId, templateCode: 'ACCOUNT_IMPERSONATED' },
    });
    expect(JSON.stringify(notice)).not.toContain(maker.userId);

    await request(ctx.server).post(`/admin/impersonation-sessions/${sessionId}/end`).set(...auth(maker.accessToken)).expect(200);
    await request(ctx.server).get('/users/me').set(...auth(token)).expect(401);
    const mine = body(await request(ctx.server).get('/admin/impersonation-sessions').set(...auth(maker.accessToken)).expect(200));
    expect((mine.items as Array<{ id: string; status: string }>)[0]).toMatchObject({ id: sessionId, status: 'ENDED' });
  });

  it('refuses the token once the session has run out, and a session started too late', async () => {
    const sessionId = await approvedSession();
    const token = body(await start(maker.accessToken, sessionId).expect(200)).accessToken as string;
    await ctx.prisma.impersonationSession.update({ where: { id: sessionId }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await request(ctx.server).get('/users/me').set(...auth(token)).expect(401);

    const late = await approvedSession();
    await ctx.prisma.impersonationSession.update({ where: { id: late }, data: { redeemBy: new Date(Date.now() - 1000) } });
    expect(errorOf(await start(maker.accessToken, late).expect(409)).code).toBe(ErrorCode.IMPERSONATION_SESSION_CLOSED);
  });

  it('cannot be made single-actor: with the action switched off, the request is refused', async () => {
    const superAdmin = (await createUserWithRole(ctx, 'SUPER_ADMIN')).accessToken;
    await request(ctx.server)
      .put('/admin/config/approvals/makerCheckerActions')
      .set(...auth(superAdmin))
      .send({ valueType: 'JSON', value: [] })
      .expect(200);
    expect(errorOf(await ask(maker.accessToken, target.userId).expect(403)).code).toBe(ErrorCode.IMPERSONATION_NOT_ALLOWED);
    expect(await ctx.prisma.impersonationSession.count()).toBe(0);
  });
});
