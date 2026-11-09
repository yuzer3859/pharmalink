import { describe, expect, it, vi } from 'vitest';
import type { SessionRequest } from './auth.service';
import {
  attentionItems,
  countAt,
  createPharmacyDashboardService,
  statementQuery,
  statusSlices,
  stockBars,
  weekSeries,
  type PharmacyDashboard,
} from './pharmacyDashboard.service';

const dashboard = (over: Partial<PharmacyDashboard['orders']> = {}, stock: Partial<PharmacyDashboard['stock']> = {}): PharmacyDashboard => ({
  orders: {
    byStatus: [
      { status: 'PENDING', count: 2 },
      { status: 'READY', count: 1 },
      { status: 'DELIVERED', count: 0 },
    ],
    newLast24h: 3,
    deliveredRevenue30d: 125000,
    currency: 'ETB',
    last7Days: [
      { date: '2026-11-04', orders: 0, deliveredRevenue: 0 },
      { date: '2026-11-10', orders: 3, deliveredRevenue: 4550 },
    ],
    ...over,
  },
  stock: { listings: 10, enabledListings: 8, outOfStock: 1, lowStock: 2, batchesExpiringSoon: 1, batchesExpired: 0, ...stock },
  generatedAt: '2026-11-10T08:00:00.000Z',
});

describe('dashboard figures', () => {
  it('reads counts by status, 0 when absent', () => {
    expect(countAt(dashboard(), 'PENDING')).toBe(2);
    expect(countAt(dashboard(), 'CANCELLED')).toBe(0);
  });

  it('turns the week into chart points in birr', () => {
    expect(weekSeries(dashboard())).toEqual([
      { period: '11-04', orders: 0, revenue: 0 },
      { period: '11-10', orders: 3, revenue: 45.5 },
    ]);
  });

  it('leaves empty slices out of the status chart', () => {
    expect(statusSlices(dashboard())).toEqual([
      { name: 'pending', value: 2 },
      { name: 'ready', value: 1 },
    ]);
  });

  it('splits listings by stock level, never below zero', () => {
    expect(stockBars(dashboard())).toEqual([
      { name: 'In stock', value: 5 },
      { name: 'Low stock', value: 2 },
      { name: 'Out of stock', value: 1 },
      { name: 'Not sold', value: 2 },
    ]);
    expect(stockBars(dashboard({}, { listings: 0, enabledListings: 0, outOfStock: 0, lowStock: 0 }))[0].value).toBe(0);
  });

  it('lists what needs attention in plain words, and nothing when all is well', () => {
    expect(attentionItems(dashboard())).toEqual([
      '2 new orders to accept or decline',
      '1 order ready, waiting for a driver',
      '1 listing out of stock',
      '1 batch expiring within 30 days',
    ]);
    expect(attentionItems(dashboard({ byStatus: [] }, { outOfStock: 0, batchesExpiringSoon: 0, batchesExpired: 0 }))).toEqual([]);
  });
});

describe('statementQuery', () => {
  it('sends only what is set, capped at 50', () => {
    expect(statementQuery({ status: 'all' })).toBe('');
    expect(statementQuery({ status: 'PAID', page: 2, size: 25 })).toBe('?status=PAID&page=2&size=25');
    expect(statementQuery({ size: 500 })).toBe('?size=50');
  });
});

describe('pharmacyDashboardService', () => {
  it('reads the dashboard, the statements and one statement', async () => {
    const request = vi.fn().mockResolvedValue({});
    const s = createPharmacyDashboardService(request as unknown as SessionRequest);
    await s.dashboard();
    expect(request).toHaveBeenLastCalledWith('/pharmacy/dashboard', { method: 'GET' });
    await s.statements({ page: 1, size: 25 });
    expect(request).toHaveBeenLastCalledWith('/settlements?page=1&size=25', { method: 'GET' });
    await s.statement('st/1');
    expect(request).toHaveBeenLastCalledWith('/settlements/st%2F1', { method: 'GET' });
  });

  it('is read-only', () => {
    const s = createPharmacyDashboardService(vi.fn() as unknown as SessionRequest);
    expect(Object.keys(s).sort()).toEqual(['dashboard', 'statement', 'statements']);
  });
});
