import { describe, expect, it, vi } from 'vitest';
import { adminOrderQuery, createAdminOrdersService, fromMinorUnits, isOrderNumberFilter } from './adminOrders.service';
import type { SessionRequest } from './auth.service';

describe('adminOrderQuery', () => {
  it('sends only the filters that are set', () => {
    expect(adminOrderQuery({})).toBe('');
    expect(adminOrderQuery({ status: 'all', orderNumber: '   ' })).toBe('');
    expect(adminOrderQuery({ status: 'PAID', isCod: true, orderNumber: ' PL-2026-0001 ', page: 3, size: 10 })).toBe(
      '?status=PAID&isCod=true&orderNumber=PL-2026-0001&page=3&size=10',
    );
    expect(adminOrderQuery({ isCod: false })).toBe('?isCod=false');
  });
});

describe('isOrderNumberFilter', () => {
  it('follows the server rule: letters, digits and hyphens, at most 64', () => {
    expect(isOrderNumberFilter('PL-2026-0001')).toBe(true);
    expect(isOrderNumberFilter(' PL-1 ')).toBe(true);
    expect(isOrderNumberFilter('PL 1')).toBe(false);
    expect(isOrderNumberFilter('PL_1')).toBe(false);
    expect(isOrderNumberFilter('x'.repeat(65))).toBe(false);
  });
});

describe('fromMinorUnits', () => {
  it('converts santim to birr', () => {
    expect(fromMinorUnits(12345)).toBe(123.45);
    expect(fromMinorUnits(0)).toBe(0);
  });
});

describe('adminOrdersService', () => {
  it('lists from GET /admin/operations/orders and reads one order by id', async () => {
    const request = vi.fn().mockResolvedValue({ items: [], total: 0, page: 1, size: 25 });
    const service = createAdminOrdersService(request as unknown as SessionRequest);

    await service.list({ status: 'CANCELLED', page: 1, size: 25 });
    expect(request).toHaveBeenLastCalledWith('/admin/operations/orders?status=CANCELLED&page=1&size=25', { method: 'GET' });

    await service.get('o/1');
    expect(request).toHaveBeenLastCalledWith('/admin/operations/orders/o%2F1', { method: 'GET' });
  });

  it('is read-only', () => {
    const service = createAdminOrdersService(vi.fn() as unknown as SessionRequest);
    expect(Object.keys(service).sort()).toEqual(['get', 'list']);
  });
});
