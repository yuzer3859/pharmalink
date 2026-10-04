import request from 'supertest';
import { auth, body, createUserWithRole, errorOf, login, registerAndVerify } from '../support/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';

/** Scenarios 7-8: verification submission → admin approval / rejection → status confirmation. */
describe('Fayda verification workflow (e2e)', () => {
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

  it('submits, appears in the admin queue, and is approved end to end', async () => {
    const user = await registerAndVerify(ctx);
    const { accessToken } = await login(ctx, user.phone, user.password);

    const submit = await request(ctx.server)
      .post('/verification/fayda')
      .set(...auth(accessToken))
      .send({ faydaId: '123456789012', consentGranted: true })
      .expect(202);
    const requestId = body(submit).requestId as string;
    expect(body(submit).status).toBe('PENDING');

    // The Fayda number must never appear in the response.
    expect(JSON.stringify(submit.body)).not.toContain('123456789012');

    const admin = await createUserWithRole(ctx, 'ADMIN');
    const queue = await request(ctx.server)
      .get('/admin/verification/queue')
      .set(...auth(admin.accessToken))
      .expect(200);
    const queueItems = body(queue).items as Array<{ requestId: string }>;
    expect(queueItems.map((i) => i.requestId)).toContain(requestId);
    // The queue must never carry the Fayda number either.
    expect(JSON.stringify(queue.body)).not.toContain('123456789012');

    await request(ctx.server)
      .post(`/admin/verification/${requestId}/approve`)
      .set(...auth(admin.accessToken))
      .send({})
      .expect(204);

    const status = await request(ctx.server)
      .get('/verification/status')
      .set(...auth(accessToken))
      .expect(200);
    const statusItems = body(status) as unknown as Array<{
      requestId: string;
      status: string;
      faydaIdMasked: string | null;
    }>;
    const approved = statusItems.find((i) => i.requestId === requestId)!;
    expect(approved.status).toBe('APPROVED');
    expect(approved.faydaIdMasked).toBe('****9012');

    const stored = await ctx.prisma.user.findUniqueOrThrow({ where: { id: user.userId } });
    expect(stored.faydaVerifiedAt).not.toBeNull();
  });

  it('rejects with a reason and reports it back to the user', async () => {
    const user = await registerAndVerify(ctx);
    const { accessToken } = await login(ctx, user.phone, user.password);

    const submit = await request(ctx.server)
      .post('/verification/fayda')
      .set(...auth(accessToken))
      .send({ faydaId: '123456789012', consentGranted: true })
      .expect(202);
    const requestId = body(submit).requestId as string;

    const admin = await createUserWithRole(ctx, 'ADMIN');
    await request(ctx.server)
      .post(`/admin/verification/${requestId}/reject`)
      .set(...auth(admin.accessToken))
      .send({ reason: 'Fayda number does not match registry records' })
      .expect(204);

    const status = await request(ctx.server)
      .get('/verification/status')
      .set(...auth(accessToken))
      .expect(200);
    const rejected = (
      body(status) as unknown as Array<{ requestId: string; status: string; rejectReason: string }>
    ).find((i) => i.requestId === requestId)!;
    expect(rejected.status).toBe('REJECTED');
    expect(rejected.rejectReason).toBe('Fayda number does not match registry records');

    const stored = await ctx.prisma.user.findUniqueOrThrow({ where: { id: user.userId } });
    expect(stored.faydaVerifiedAt).toBeNull();
  });

  it('refuses consent-less submission and never opens a request', async () => {
    const user = await registerAndVerify(ctx);
    const { accessToken } = await login(ctx, user.phone, user.password);

    const res = await request(ctx.server)
      .post('/verification/fayda')
      .set(...auth(accessToken))
      .send({ faydaId: '123456789012', consentGranted: false })
      .expect(400);
    expect(errorOf(res).code).toBe('VALIDATION_ERROR');

    const count = await ctx.prisma.verificationRequest.count();
    expect(count).toBe(0);
  });

  it('a non-admin cannot reach the verification queue', async () => {
    const user = await registerAndVerify(ctx);
    const { accessToken } = await login(ctx, user.phone, user.password);

    const res = await request(ctx.server)
      .get('/admin/verification/queue')
      .set(...auth(accessToken))
      .expect(403);
    expect(errorOf(res).code).toBe('FORBIDDEN');
  });
});
