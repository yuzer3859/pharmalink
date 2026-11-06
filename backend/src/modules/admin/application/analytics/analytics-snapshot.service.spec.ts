import { PERMISSIONS_KEY } from '../../../../shared/rbac/permissions.decorator';
import { AdminAnalyticsController } from '../../interface/controllers/admin-analytics.controller';
import { IAnalyticsSnapshotRepository, SnapshotRow } from '../ports/analytics-snapshot.repository.port';
import { AnalyticsSnapshotService, flattenOverview, MAX_METRICS, MAX_RANGE_DAYS, utcDay } from './analytics-snapshot.service';

class FakeRepo implements IAnalyticsSnapshotRepository {
  days = new Map<string, Map<string, number>>();
  async upsertDay(day: Date, values: Map<string, number>): Promise<void> {
    this.days.set(day.toISOString().slice(0, 10), new Map(values));
  }
  async findRange(keys: string[], from: Date, to: Date): Promise<SnapshotRow[]> {
    const rows: SnapshotRow[] = [];
    for (const [day, values] of this.days) {
      const windowStart = new Date(`${day}T00:00:00.000Z`);
      if (windowStart < from || windowStart > to) continue;
      for (const k of keys) if (values.has(k)) rows.push({ metricKey: k, windowStart, value: values.get(k)! });
    }
    return rows;
  }
  async listMetricKeys(): Promise<string[]> {
    return [...new Set([...this.days.values()].flatMap((v) => [...v.keys()]))].sort();
  }
}

const VIEW = {
  generatedAt: new Date('2026-11-06T23:59:30.000Z'),
  accounts: { total: 3, byStatus: [{ status: 'ACTIVE', count: 3 }], byPrimaryRole: [{ primaryRole: 'ADMIN', count: 1 }] },
  catalog: { products: { total: 0, byStatus: [] } },
  providers: { pharmacies: { total: 1, eligible: 1, byTransactingStatus: [], byLicenseStatus: [] }, branches: { total: 0, active: 0, inactive: 0 }, listings: { total: 0, enabled: 0, disabled: 0, inStock: 0, outOfStock: 0 } },
  orders: { orders: { total: 2, byStatus: [{ status: 'DELIVERED', count: 2 }] }, fulfillments: { total: 0, byStatus: [] } },
  delivery: { jobs: { total: 0, byStatus: [] }, drivers: { total: 0, dispatchable: 0, byAvailability: [{ availability: 'ONLINE', count: 0 }] } },
  cod: { count: 1, expectedAmount: 24_500 },
};

const setup = () => {
  const repo = new FakeRepo();
  const audit = { record: jest.fn().mockResolvedValue({ id: 'a', hash: 'h' }) };
  const overview = { execute: jest.fn().mockResolvedValue(VIEW) };
  const svc = new AnalyticsSnapshotService(overview as never, repo, audit as never);
  return { repo, audit, svc };
};

describe('Analytics time series (Work 87)', () => {
  it('flattens numbers and labelled buckets into dotted metric keys', () => {
    const flat = flattenOverview({ a: { total: 2, byStatus: [{ status: 'X', count: 1 }, { availability: 'ON', count: 4 }] }, when: new Date(), name: 'n' });
    expect([...flat]).toEqual([
      ['a.total', 2],
      ['a.byStatus.X', 1],
      ['a.byStatus.ON', 4],
    ]);
  });

  it('keys a snapshot by its UTC day', () => {
    expect(utcDay(new Date('2026-11-06T23:59:59.999Z')).toISOString()).toBe('2026-11-06T00:00:00.000Z');
    expect(utcDay(new Date('2026-11-07T00:00:00.000Z')).toISOString()).toBe('2026-11-07T00:00:00.000Z');
  });

  it('snapshots every section (never generatedAt), audits only a manual run', async () => {
    const { repo, audit, svc } = setup();
    const job = await svc.snapshot();
    expect(job.day).toBe('2026-11-06');
    const values = repo.days.get('2026-11-06')!;
    expect(values.get('accounts.total')).toBe(3);
    expect(values.get('orders.orders.byStatus.DELIVERED')).toBe(2);
    expect(values.get('delivery.drivers.byAvailability.ONLINE')).toBe(0);
    expect(values.get('cod.expectedAmount')).toBe(24_500);
    expect([...values.keys()].some((k) => k.startsWith('generatedAt'))).toBe(false);
    expect(audit.record).not.toHaveBeenCalled();

    await svc.snapshot({ userId: 'u1', ip: '1.2.3.4' });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ actorUserId: 'u1', action: 'ANALYTICS_SNAPSHOT_TAKEN', resourceType: 'AnalyticsSnapshot', resourceId: '2026-11-06', ip: '1.2.3.4' }),
    );
    expect(repo.days.size).toBe(1);
  });

  it('fills each day of the range, null where nothing was taken', async () => {
    const { repo, svc } = setup();
    repo.days.set('2026-11-01', new Map([['a', 1]]));
    repo.days.set('2026-11-03', new Map([['a', 3], ['b', 9]]));
    const view = await svc.timeseries({ metrics: ['a', 'b', 'a'], from: '2026-11-01', to: '2026-11-04' });
    expect(view.series).toEqual([
      { metric: 'a', points: [{ date: '2026-11-01', value: 1 }, { date: '2026-11-02', value: null }, { date: '2026-11-03', value: 3 }, { date: '2026-11-04', value: null }] },
      { metric: 'b', points: [{ date: '2026-11-01', value: null }, { date: '2026-11-02', value: null }, { date: '2026-11-03', value: 9 }, { date: '2026-11-04', value: null }] },
    ]);
  });

  it('defaults to the 30 days ending today', async () => {
    const { svc } = setup();
    const view = await svc.timeseries({ metrics: ['a'] }, new Date('2026-11-06T10:00:00Z'));
    expect([view.from, view.to]).toEqual(['2026-10-08', '2026-11-06']);
    expect(view.series[0].points).toHaveLength(30);
  });

  it('refuses empty, too many, reversed, too long and impossible ranges', async () => {
    const { svc } = setup();
    const many = Array.from({ length: MAX_METRICS + 1 }, (_, i) => `m${i}`);
    await expect(svc.timeseries({ metrics: [] })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(svc.timeseries({ metrics: many })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(svc.timeseries({ metrics: ['a'], from: '2026-03-02', to: '2026-03-01' })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(svc.timeseries({ metrics: ['a'], from: '2026-02-30' })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    const lastOk = new Date(Date.UTC(2026, 0, 1) + (MAX_RANGE_DAYS - 1) * 86_400_000).toISOString().slice(0, 10);
    await expect(svc.timeseries({ metrics: ['a'], from: '2026-01-01', to: lastOk })).resolves.toBeDefined();
    const tooFar = new Date(Date.UTC(2026, 0, 1) + MAX_RANGE_DAYS * 86_400_000).toISOString().slice(0, 10);
    await expect(svc.timeseries({ metrics: ['a'], from: '2026-01-01', to: tooFar })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('serves the time series under analytics:read', () => {
    expect(Reflect.getMetadata(PERMISSIONS_KEY, AdminAnalyticsController)).toEqual(['analytics:read']);
  });
});
