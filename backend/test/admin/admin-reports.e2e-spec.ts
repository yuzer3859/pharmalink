import request from 'supertest';
import { ReportWorkerJob } from '../../src/modules/admin/infrastructure/jobs/report-worker.job';
import { AuditService } from '../../src/shared/audit/audit.service';
import { ErrorCode } from '../../src/shared/errors/error-codes';
import { auth, body, createUserWithRole, errorOf } from '../support/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';

const BASE = '/admin/reports';
const today = () => new Date().toISOString().slice(0, 10);
const pathOf = (url: string) => new URL(url).pathname;

interface ReportBody {
  id: string;
  type: string;
  status: string;
  rowCount: number | null;
  truncated: boolean;
  fileName: string;
  expiresAt: string | null;
}

/**
 * Work 90 against real PostgreSQL and the real HTTP stack: a report queued, built by the worker
 * through the owners' read ports, stored in document storage (memory under test) and downloaded
 * through a signed link (backend/docs/reports.md).
 */
describe('Admin reports (e2e)', () => {
  let ctx: TestContext;
  let admin: Awaited<ReturnType<typeof createUserWithRole>>;
  let worker: ReportWorkerJob;

  beforeAll(async () => {
    ctx = await createTestApp();
    worker = ctx.app.get(ReportWorkerJob);
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  beforeEach(async () => {
    await ctx.reset();
    admin = await createUserWithRole(ctx, 'ADMIN');
  });

  const ask = (token: string, payload: Record<string, unknown>, key = `k-${Math.random()}`) =>
    request(ctx.server).post(BASE).set(...auth(token)).set('Idempotency-Key', key).send(payload);
  const download = (token: string, id: string) => request(ctx.server).post(`${BASE}/${id}/download`).set(...auth(token)).send({});
  const fetchCsv = async (url: string) =>
    (
      await request(ctx.server)
        .get(pathOf(url))
        .buffer(true)
        .parse((res, cb) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => cb(null, Buffer.concat(chunks)));
        })
        .expect(200)
    ).body as Buffer;

  it('queues, builds in the background and downloads an audit report with formula cells neutralised', async () => {
    await ctx.app.get(AuditService).record({ actorUserId: admin.userId, action: '=HYPERLINK("http://evil")', resourceType: 'Test, "quoted"' });
    const queued = body(await ask(admin.accessToken, { type: 'AUDIT', from: today(), to: today() }).expect(202)) as unknown as ReportBody;
    expect(queued).toMatchObject({ type: 'AUDIT', status: 'QUEUED', rowCount: null });
    await download(admin.accessToken, queued.id).expect(409);

    expect(await worker.runOnce()).toBe(1);
    const done = body(await request(ctx.server).get(`${BASE}/${queued.id}`).set(...auth(admin.accessToken)).expect(200)) as unknown as ReportBody;
    expect(done.status).toBe('SUCCEEDED');
    expect(done.rowCount).toBeGreaterThanOrEqual(1);
    expect(done.fileName).toBe(`pharmalink-audit-${today()}-to-${today()}.csv`);

    const link = body(await download(admin.accessToken, queued.id).expect(200)) as { url: string; expiresAt: string };
    const csv = await fetchCsv(link.url);
    expect([...csv.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const text = csv.subarray(3).toString('utf8');
    const lines = text.split('\r\n');
    expect(lines[0]).toBe('id,createdAt,actorUserId,action,resourceType,resourceId,ip,hash');
    expect(text).toContain(`"'=HYPERLINK(""http://evil"")"`);
    expect(text).toContain('"Test, ""quoted"""');
    expect(lines.filter(Boolean)).toHaveLength(done.rowCount! + 1);

    const trail = await ctx.prisma.auditLog.findMany({ where: { action: { in: ['REPORT_REQUESTED', 'REPORT_DOWNLOADED'] } }, orderBy: { createdAt: 'asc' } });
    expect(trail.map((a) => [a.action, a.actorUserId, a.resourceId])).toEqual([
      ['REPORT_REQUESTED', admin.userId, queued.id],
      ['REPORT_DOWNLOADED', admin.userId, queued.id],
    ]);
  });

  it('builds every type, an empty one as its header row only', async () => {
    for (const type of ['PAYMENTS', 'REFUNDS', 'ORDERS', 'ANALYTICS_DAILY']) {
      await ask(admin.accessToken, { type, from: today(), to: today() }).expect(202);
    }
    expect(await worker.runOnce()).toBe(4);
    const jobs = await ctx.prisma.reportJob.findMany();
    expect(jobs.map((j) => j.status)).toEqual(['SUCCEEDED', 'SUCCEEDED', 'SUCCEEDED', 'SUCCEEDED']);
    const orders = jobs.find((j) => j.type === 'ORDERS')!;
    const link = body(await download(admin.accessToken, orders.id).expect(200)) as { url: string };
    expect((await fetchCsv(link.url)).subarray(3).toString('utf8')).toBe('orderId,orderNumber,status,isCod,grandTotalMinor,currency,lineCount,fulfillmentCount,placedAt,createdAt\r\n');
    expect(orders.rowCount).toBe(0);
  });

  it('is idempotent per requester and key, and refuses a key reused for a different report', async () => {
    const payload = { type: 'ORDERS', from: today(), to: today() };
    const first = body(await ask(admin.accessToken, payload, 'same-key-1').expect(202)) as unknown as ReportBody;
    const again = body(await ask(admin.accessToken, payload, 'same-key-1').expect(200)) as unknown as ReportBody;
    expect(again.id).toBe(first.id);
    expect(errorOf(await ask(admin.accessToken, { ...payload, type: 'AUDIT' }, 'same-key-1').expect(409)).code).toBe(ErrorCode.IDEMPOTENCY_CONFLICT);
    // Another requester's same key is their own.
    const other = await createUserWithRole(ctx, 'ADMIN');
    await ask(other.accessToken, payload, 'same-key-1').expect(202);
    expect(await ctx.prisma.reportJob.count()).toBe(2);
    await request(ctx.server).post(BASE).set(...auth(admin.accessToken)).send(payload).expect(400);
  });

  it.each([
    ['an unknown type', { type: 'SALARIES', from: '2026-01-01', to: '2026-01-02' }],
    ['a malformed date', { type: 'ORDERS', from: '2026/01/01', to: '2026-01-02' }],
    ['an impossible date', { type: 'ORDERS', from: '2026-02-30', to: '2026-03-01' }],
    ['from after to', { type: 'ORDERS', from: '2026-03-02', to: '2026-03-01' }],
    ['more than 366 days', { type: 'ORDERS', from: '2025-01-01', to: '2026-01-02' }],
    ['an unknown field', { type: 'ORDERS', from: '2026-01-01', to: '2026-01-02', requestedBy: 'x' }],
  ])('refuses %s with 400', async (_label, payload) => {
    expect(errorOf(await ask(admin.accessToken, payload).expect(400)).code).toBe(ErrorCode.VALIDATION_ERROR);
  });

  it('gives a finance officer payments and refunds only, and nobody else’s reports', async () => {
    const finance = await createUserWithRole(ctx, 'FINANCE_OFFICER');
    const types = body(await request(ctx.server).get(`${BASE}/types`).set(...auth(finance.accessToken)).expect(200)) as { types: Array<{ type: string; allowed: boolean }> };
    expect(types.types.filter((t) => t.allowed).map((t) => t.type)).toEqual(['PAYMENTS', 'REFUNDS']);
    await ask(finance.accessToken, { type: 'AUDIT', from: today(), to: today() }).expect(403);
    await ask(finance.accessToken, { type: 'ORDERS', from: today(), to: today() }).expect(403);
    const mine = body(await ask(finance.accessToken, { type: 'PAYMENTS', from: today(), to: today() }).expect(202)) as unknown as ReportBody;

    const adminJob = body(await ask(admin.accessToken, { type: 'AUDIT', from: today(), to: today() }).expect(202)) as unknown as ReportBody;
    await worker.runOnce();
    await request(ctx.server).get(`${BASE}/${adminJob.id}`).set(...auth(finance.accessToken)).expect(404);
    await download(finance.accessToken, adminJob.id).expect(404);
    const list = body(await request(ctx.server).get(BASE).set(...auth(finance.accessToken)).expect(200)) as { items: ReportBody[]; total: number };
    expect(list.items.map((i) => i.id)).toEqual([mine.id]);
  });

  it.each(['CUSTOMER', 'CUSTOMER_SUPPORT', 'DRIVER'] as const)('refuses %s', async (role) => {
    const caller = await createUserWithRole(ctx, role);
    await ask(caller.accessToken, { type: 'PAYMENTS', from: today(), to: today() }).expect(403);
    await request(ctx.server).get(BASE).set(...auth(caller.accessToken)).expect(403);
  });

  it('refuses an unauthenticated caller', async () => {
    await request(ctx.server).get(BASE).expect(401);
  });

  it('expires a finished report after its retention', async () => {
    const job = body(await ask(admin.accessToken, { type: 'ORDERS', from: today(), to: today() }).expect(202)) as unknown as ReportBody;
    await worker.runOnce();
    const stored = await ctx.prisma.reportJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(stored.expiresAt!.getTime() - stored.finishedAt!.getTime()).toBeGreaterThan(6.9 * 86_400_000);
    await ctx.prisma.reportJob.update({ where: { id: job.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((body(await request(ctx.server).get(`${BASE}/${job.id}`).set(...auth(admin.accessToken)).expect(200)) as unknown as ReportBody).status).toBe('EXPIRED');
    await download(admin.accessToken, job.id).expect(409);
  });
});
