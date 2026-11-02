import { describe, expect, it, vi } from 'vitest';
import { countOf, createAdminAnalyticsService, humanizeStatus, toChartData } from './adminAnalytics.service';
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
  it('reads GET /admin/analytics/overview and nothing else', async () => {
    const request = vi.fn().mockResolvedValue({ generatedAt: '2026-11-02T00:00:00.000Z' });
    const service = createAdminAnalyticsService(request as unknown as SessionRequest);

    await service.overview();
    expect(request).toHaveBeenCalledWith('/admin/analytics/overview', { method: 'GET' });
    expect(Object.keys(service)).toEqual(['overview']);
  });
});
