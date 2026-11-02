import { describe, expect, it } from 'vitest';
import { AdminOrdersPage } from '@/features/orders/AdminOrdersPage';
import { OrdersPage } from '@/features/orders/OrdersPage';
import { AuditPage } from '@/features/audit/AuditPage';
import { pageFor } from './pageRegistry';

describe('pageFor', () => {
  it('gives the admin portals the platform-wide orders page and the pharmacy portal its own', () => {
    expect(pageFor('admin', 'orders')).toBe(AdminOrdersPage);
    expect(pageFor('superadmin', 'orders')).toBe(AdminOrdersPage);
    expect(pageFor('pharmacy', 'orders')).toBe(OrdersPage);
  });

  it('falls back to the shared page, and to nothing for an unknown path', () => {
    expect(pageFor('admin', 'audit')).toBe(AuditPage);
    expect(pageFor('admin', 'nope')).toBeUndefined();
  });
});
