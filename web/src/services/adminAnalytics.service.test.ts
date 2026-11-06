import { describe, expect, it, vi } from 'vitest';
import { countOf, createAdminAnalyticsService, hasAnyPoint, humanizeStatus, rangeStart, toChartData, toTrendData } from './adminAnalytics.service';
import { TRENDS } from '@/features/analytics/analyticsTrends.config';
import type { SessionRequest } from './auth.service';

describe('humanizeStatus', () => {
  it('turns a persisted enum value into a label', () => {
    expect(humanizeStatus('PENDING_PAYMENT')).toBe('Pending payment');
    expect(humanizeStatus('ACTIVE')).toBe('Active');
    expect(humanizeStatus('SUPER_ADMIN')).toBe('Super admin');
  });
});

describe('toChartData', () => {
  it('keeps the server order and drops empty buckets', () => {
    expect(
      toChartData([
        { status: 'PAID', count: 3 },
        { status: 'CANCELLED', count: 0 },
        { status: 'DELIVERED', count: 7 },
      ]),
    ).toEqual([
      { name: 'Paid', value: 3 },
      { name: 'Delivered', value: 7 },
    ]);
    expect(toChartData([])).toEqual([]);
  });
});

describe('countOf', () => {
  it('reads one bucket, 0 when absent', () => {
    const buckets = [{ status: 'ACTIVE', count: 4 }];
    expect(countOf(buckets, 'ACTIVE')).toBe(4);
    expect(countOf(buckets, 'SUSPENDED')).toBe(0);
  });
});

describe('adminAnalyticsService', () => {
  it('reads the overview and the time series, and takes a snapshot (Work 87)', async () => {
    const request = vi.fn().mockResolvedValue({ generatedAt: '2026-11-02T00:00:00.000Z' });
    const service = createAdminAnalyticsService(request as unknown as SessionRequest);

    await service.overview();
    expect(request).toHaveBeenLastCalledWith('/admin/analytics/overview', { method: 'GET' });
    await service.timeseries(['orders.orders.total', 'accounts.total'], { from: '2026-10-08' });
    expect(request).toHaveBeenLastCalledWith('/admin/analytics/timeseries?metrics=orders.orders.total%2Caccounts.total&from=2026-10-08', { method: 'GET' });
    await service.timeseries(['a']);
    expect(request).toHaveBeenLastCalledWith('/admin/analytics/timeseries?metrics=a', { method: 'GET' });
    await service.snapshotNow();
    expect(request).toHaveBeenLastCalledWith('/admin/analytics/snapshots', { method: 'POST', body: {} });
    expect(Object.keys(service)).toEqual(['overview', 'timeseries', 'snapshotNow']);
  });
});

describe('trend helpers (Work 87)', () => {
  const view = {
    from: '2026-11-01',
    to: '2026-11-03',
    series: [
      { metric: 'cod.expectedAmount', points: [{ date: '2026-11-01', value: 10_000 }, { date: '2026-11-02', value: null }, { date: '2026-11-03', value: 25_050 }] },
      { metric: 'accounts.total', points: [{ date: '2026-11-01', value: 3 }, { date: '2026-11-02', value: 4 }, { date: '2026-11-03', value: null }] },
    ],
  };

  it('turns series into positional chart rows, keeping gaps as null and scaling values', () => {
    expect(toTrendData(view, ['accounts.total', 'cod.expectedAmount'], (v) => v / 100)).toEqual([
      { period: '11-01', s0: 0.03, s1: 100 },
      { period: '11-02', s0: 0.04, s1: null },
      { period: '11-03', s0: null, s1: 250.5 },
    ]);
  });

  it('knows an all-gap view from one with data', () => {
    expect(hasAnyPoint(view)).toBe(true);
    expect(hasAnyPoint({ ...view, series: view.series.map((s) => ({ ...s, points: s.points.map((p) => ({ ...p, value: null })) })) })).toBe(false);
  });

  it('starts a range so it covers the given number of UTC days, today included', () => {
    expect(rangeStart(30, new Date('2026-11-06T22:00:00Z'))).toBe('2026-10-08');
    expect(rangeStart(1, new Date('2026-11-06T00:00:00Z'))).toBe('2026-11-06');
  });

  it('charts at most eight metrics each, all snapshot keys', () => {
    for (const def of TRENDS) {
      expect(def.lines.length).toBeLessThanOrEqual(8);
      for (const line of def.lines) expect(line.metric).toMatch(/^(accounts|catalog|providers|orders|delivery|cod)\.[A-Za-z0-9_.]+$/);
    }
  });
});
