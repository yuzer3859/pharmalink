import request from 'supertest';
import { AnalyticsSnapshotJob } from '../../src/modules/admin/infrastructure/jobs/analytics-snapshot.job';
import { ErrorCode } from '../../src/shared/errors/error-codes';
import { auth, body, createUserWithRole, errorOf } from '../support/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';

const BASE = '/admin/analytics';
const DAY_MS = 24 * 60 * 60 * 1000;
const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const utcMidnight = (d: Date) => new Date(`${isoDay(d)}T00:00:00.000Z`);

interface Series {
  from: string;
  to: string;
  series: Array<{ metric: string; points: Array<{ date: string; value: number | null }> }>;
}

/**
 * Work 87 against real PostgreSQL and the real HTTP stack: daily snapshots of the overview in
 * `dashboard_metrics`, served as time series (backend/docs/analytics-timeseries.md).
 */
describe('Admin analytics time series (e2e)', () => {
  let ctx: TestContext;
  let admin: Awaited<ReturnType<typeof createUserWithRole>>;

  beforeAll(async () => {
    ctx = await createTestApp();
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  beforeEach(async () => {
    await ctx.reset();
    admin = await createUserWithRole(ctx, 'ADMIN');
  });

  const snapshot = (token: string) => request(ctx.server).post(`${BASE}/snapshots`).set(...auth(token)).send({});
  const series = (token: string, query: Record<string, string>) =>
    request(ctx.server).get(`${BASE}/timeseries`).query(query).set(...auth(token));
  const overviewTotal = async () =>
    (body(await request(ctx.server).get(`${BASE}/overview`).set(...auth(admin.accessToken)).expect(200)) as {
      accounts: { total: number };
    }).accounts.total;

  describe('snapshots', () => {
    it('stores today’s value of every overview figure, keyed by its path, and audits the manual run', async () => {
      const res = body(await snapshot(admin.accessToken).expect(200)) as { day: string; metrics: number; takenAt: string };
      const today = isoDay(new Date());
      expect(res.day).toBe(today);

      const rows = await ctx.prisma.dashboardMetric.findMany({ where: { windowStart: utcMidnight(new Date()) } });
      expect(rows.length).toBe(res.metrics);
      expect(rows.every((r) => r.dimension === 'all')).toBe(true);
      const byKey = new Map(rows.map((r) => [r.metricKey, r.value]));
      expect(byKey.get('accounts.total')).toBe(await overviewTotal());
      // Fixtures register every user as a CUSTOMER first, so that is the admin's primary role.
      expect(byKey.get('accounts.byPrimaryRole.CUSTOMER')).toBeGreaterThanOrEqual(1);
      for (const key of ['orders.orders.total', 'orders.orders.byStatus.DELIVERED', 'delivery.jobs.byStatus.COMPLETED', 'cod.expectedAmount', 'providers.listings.inStock']) {
        expect({ key, present: byKey.has(key) }).toEqual({ key, present: true });
      }
      expect(byKey.has('generatedAt')).toBe(false);

      const audits = await ctx.prisma.auditLog.findMany({ where: { action: 'ANALYTICS_SNAPSHOT_TAKEN' } });
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({ actorUserId: admin.userId, resourceType: 'AnalyticsSnapshot', resourceId: today });
    });

    it('is idempotent per day: a second run replaces today’s values and adds no row', async () => {
      await snapshot(admin.accessToken).expect(200);
      const before = await ctx.prisma.dashboardMetric.count();
      const firstTotal = (await ctx.prisma.dashboardMetric.findFirstOrThrow({ where: { metricKey: 'accounts.total' } })).value;

      await createUserWithRole(ctx, 'CUSTOMER');
      await snapshot(admin.accessToken).expect(200);

      expect(await ctx.prisma.dashboardMetric.count()).toBe(before);
      const rows = await ctx.prisma.dashboardMetric.findMany({ where: { metricKey: 'accounts.total' } });
      expect(rows).toHaveLength(1);
      expect(rows[0].value).toBe(firstTotal + 1);
    });

    it('the background job writes the same snapshot without an audit entry', async () => {
      const metrics = await ctx.app.get(AnalyticsSnapshotJob).runOnce();
      expect(metrics).toBeGreaterThan(0);
      expect(await ctx.prisma.dashboardMetric.count()).toBe(metrics);
      expect(await ctx.prisma.auditLog.count({ where: { action: 'ANALYTICS_SNAPSHOT_TAKEN' } })).toBe(0);
    });
  });

  describe('time series', () => {
    const seedDay = (metricKey: string, daysAgo: number, value: number) => {
      const windowStart = new Date(utcMidnight(new Date()).getTime() - daysAgo * DAY_MS);
      return ctx.prisma.dashboardMetric.create({
        data: { metricKey, dimension: 'all', value, windowStart, windowEnd: new Date(windowStart.getTime() + DAY_MS) },
      });
    };

    it('returns one point per day of the range, null where no snapshot was taken', async () => {
      await seedDay('orders.orders.total', 3, 10);
      await seedDay('orders.orders.total', 1, 14);
      await seedDay('accounts.total', 2, 5);
      // A different dimension is not this series.
      await ctx.prisma.dashboardMetric.create({
        data: { metricKey: 'orders.orders.total', dimension: 'other', value: 999, windowStart: utcMidnight(new Date()), windowEnd: new Date() },
      });

      const now = new Date();
      const from = isoDay(new Date(utcMidnight(now).getTime() - 3 * DAY_MS));
      const to = isoDay(now);
      const res = body(await series(admin.accessToken, { metrics: 'orders.orders.total,accounts.total', from, to }).expect(200)) as unknown as Series;

      expect(res.from).toBe(from);
      expect(res.to).toBe(to);
      expect(res.series.map((s) => s.metric)).toEqual(['orders.orders.total', 'accounts.total']);
      expect(res.series[0].points.map((p) => p.value)).toEqual([10, null, 14, null]);
      expect(res.series[1].points.map((p) => p.value)).toEqual([null, 5, null, null]);
      expect(res.series[0].points.map((p) => p.date)[3]).toBe(to);
    });

    it('defaults to the last 30 days ending today', async () => {
      const res = body(await series(admin.accessToken, { metrics: 'accounts.total' }).expect(200)) as unknown as Series;
      expect(res.to).toBe(isoDay(new Date()));
      expect(res.series[0].points).toHaveLength(30);
    });

    it('lists the metric keys the snapshots hold, sorted', async () => {
      await snapshot(admin.accessToken).expect(200);
      const { metrics } = body(await request(ctx.server).get(`${BASE}/metrics`).set(...auth(admin.accessToken)).expect(200)) as {
        metrics: string[];
      };
      expect(metrics).toContain('accounts.total');
      expect(metrics).toEqual([...metrics].sort());
      expect(new Set(metrics).size).toBe(metrics.length);
    });

    it.each([
      ['no metric', {}],
      ['a malformed metric list', { metrics: 'a,,b' }],
      ['a malformed date', { metrics: 'accounts.total', from: '2026/01/01' }],
      ['an impossible date', { metrics: 'accounts.total', from: '2026-02-30' }],
      ['from after to', { metrics: 'accounts.total', from: '2026-03-02', to: '2026-03-01' }],
      ['more than 366 days', { metrics: 'accounts.total', from: '2024-01-01', to: '2025-12-31' }],
      ['more than eight metrics', { metrics: 'a,b,c,d,e,f,g,h,i' }],
      ['an unknown query field', { metrics: 'accounts.total', period: 'week' }],
    ])('refuses %s with 400', async (_label, query) => {
      const res = await series(admin.accessToken, query as Record<string, string>).expect(400);
      expect(errorOf(res).code).toBe(ErrorCode.VALIDATION_ERROR);
    });
  });

  describe('authorization', () => {
    it.each(['FINANCE_OFFICER', 'CUSTOMER', 'CUSTOMER_SUPPORT'] as const)('refuses %s on every route', async (role) => {
      const caller = await createUserWithRole(ctx, role);
      await snapshot(caller.accessToken).expect(403);
      await series(caller.accessToken, { metrics: 'accounts.total' }).expect(403);
      await request(ctx.server).get(`${BASE}/metrics`).set(...auth(caller.accessToken)).expect(403);
      expect(await ctx.prisma.dashboardMetric.count()).toBe(0);
    });

    it('refuses an unauthenticated caller', async () => {
      await request(ctx.server).post(`${BASE}/snapshots`).expect(401);
      await request(ctx.server).get(`${BASE}/timeseries?metrics=accounts.total`).expect(401);
    });

    it('serves SUPER_ADMIN', async () => {
      const superAdmin = await createUserWithRole(ctx, 'SUPER_ADMIN');
      await snapshot(superAdmin.accessToken).expect(200);
      await series(superAdmin.accessToken, { metrics: 'accounts.total' }).expect(200);
    });
  });
});
