import type { AdminOrderDetail, AdminOrderPage, AdminOrderStatus } from '@/types';
import { authService, type SessionRequest } from './auth.service';

/**
 * Filters of `GET /admin/operations/orders` (module-16 Work 41, `order:read:any`). Read-only
 * operations visibility: no customer data, no order actions.
 */
export interface AdminOrderFilters {
  status?: AdminOrderStatus | 'all';
  isCod?: boolean;
  /** Exact order reference; letters, digits and hyphens only (the server's rule). */
  orderNumber?: string;
  /** 1-based. */
  page?: number;
  size?: number;
}

export const ADMIN_ORDER_STATUSES: AdminOrderStatus[] = [
  'DRAFT', 'PENDING_PAYMENT', 'PAID', 'ACCEPTED', 'READY', 'DISPATCHED', 'DELIVERED', 'COMPLETED', 'CANCELLED', 'REFUNDED',
];

export const ADMIN_ORDER_PAGE_SIZES = [10, 25, 50] as const;

const ORDER_NUMBER = /^[A-Za-z0-9-]+$/;

/** True when the value can be sent as `orderNumber` (the server refuses anything else). */
export const isOrderNumberFilter = (value: string) => ORDER_NUMBER.test(value.trim()) && value.trim().length <= 64;

export function adminOrderQuery(filters: AdminOrderFilters): string {
  const params = new URLSearchParams();
  if (filters.status && filters.status !== 'all') params.set('status', filters.status);
  if (filters.isCod !== undefined) params.set('isCod', String(filters.isCod));
  const orderNumber = filters.orderNumber?.trim();
  if (orderNumber) params.set('orderNumber', orderNumber);
  if (filters.page) params.set('page', String(filters.page));
  if (filters.size) params.set('size', String(filters.size));
  const query = params.toString();
  return query ? `?${query}` : '';
}

/** Integer minor units (santim) to major units, as the API reports money. */
export const fromMinorUnits = (amount: number) => amount / 100;

export function createAdminOrdersService(request: SessionRequest) {
  return {
    list(filters: AdminOrderFilters = {}): Promise<AdminOrderPage> {
      return request<AdminOrderPage>(`/admin/operations/orders${adminOrderQuery(filters)}`, { method: 'GET' });
    },

    /** One order with its fulfillments and its payment's status. */
    get(orderId: string): Promise<AdminOrderDetail> {
      return request<AdminOrderDetail>(`/admin/operations/orders/${encodeURIComponent(orderId)}`, { method: 'GET' });
    },
  };
}

export const adminOrdersService = createAdminOrdersService(authService.request);
