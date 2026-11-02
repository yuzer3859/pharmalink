import type {
  CodDisputeDetail,
  CodDisputePage,
  CodDisputeResolution,
  CodDisputeStatus,
  FinanceOverview,
  FinancePaymentDetail,
  FinancePaymentPage,
  FinanceRefundPage,
  FinancePaymentMethod,
  FinancePaymentStatus,
  RefundStatus,
  SettlementDetail,
  SettlementPage,
  SettlementStatus,
} from '@/types';
import { ApiError } from './apiClient';
import { authService, type SessionRequest } from './auth.service';

export const PAYMENT_STATUSES: FinancePaymentStatus[] = [
  'INITIATED', 'AUTHORIZED', 'CAPTURED', 'SETTLED', 'FAILED', 'VOIDED', 'REFUNDED', 'PARTIALLY_REFUNDED', 'EXPIRED',
];
export const PAYMENT_METHODS: FinancePaymentMethod[] = ['CARD', 'TELEBIRR', 'BANK_TRANSFER', 'WALLET', 'COD', 'CROSS_BORDER'];
export const REFUND_STATUSES: RefundStatus[] = ['PENDING', 'APPROVED', 'COMPLETED', 'FAILED'];
export const SETTLEMENT_STATUSES: SettlementStatus[] = ['DRAFT', 'APPROVED', 'PAID', 'FAILED'];
export const DISPUTE_STATUSES: CodDisputeStatus[] = ['OPEN', 'RESOLVED'];
export const FINANCE_PAGE_SIZES = [10, 25, 50] as const;
/** The server's bound for a dispute resolution note. */
export const MAX_RESOLUTION_NOTE_LENGTH = 1000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (value: string) => UUID.test(value.trim());

type QueryValue = string | number | undefined;

/** A query string from the given values: trimmed, `all` and empty values left out. */
export function toQuery(values: Record<string, QueryValue>): string {
  const params = new URLSearchParams();
  for (const [key, raw] of Object.entries(values)) {
    if (raw === undefined) continue;
    const value = String(raw).trim();
    if (value && value !== 'all') params.set(key, value);
  }
  const query = params.toString();
  return query ? `?${query}` : '';
}

export interface PaymentFilters {
  status?: FinancePaymentStatus | 'all';
  method?: FinancePaymentMethod | 'all';
  orderId?: string;
  page?: number;
  size?: number;
}

export interface RefundFilters {
  status?: RefundStatus | 'all';
  paymentId?: string;
  page?: number;
  size?: number;
}

export interface SettlementFilters {
  status?: SettlementStatus | 'all';
  page?: number;
  size?: number;
}

export interface DisputeFilters {
  status?: CodDisputeStatus | 'all';
  orderId?: string;
  page?: number;
  size?: number;
}

/** UUID filters are sent only when they are UUIDs (the server refuses anything else). */
const uuidOrNothing = (value?: string) => (value && isUuid(value) ? value : undefined);

export function financeErrorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof ApiError)) return fallback;
  if (error.status === 403) return 'Your account is not allowed to see or do this.';
  if (error.status === 404) return 'That record no longer exists.';
  return `${error.message}${error.requestId ? ` (request ${error.requestId})` : ''}`;
}

export function createAdminFinanceService(request: SessionRequest) {
  const get = <T>(path: string) => request<T>(path, { method: 'GET' });
  return {
    /** `finance:report:any`: totals by status per currency, and the COD cash summary. */
    overview: () => get<FinanceOverview>('/admin/finance/overview'),

    payments: (f: PaymentFilters = {}) =>
      get<FinancePaymentPage>(
        `/admin/finance/payments${toQuery({ status: f.status, method: f.method, orderId: uuidOrNothing(f.orderId), page: f.page, size: f.size })}`,
      ),

    /** One payment with its refunds and what remains refundable. */
    payment: (id: string) => get<FinancePaymentDetail>(`/admin/finance/payments/${encodeURIComponent(id)}`),

    refunds: (f: RefundFilters = {}) =>
      get<FinanceRefundPage>(`/admin/finance/refunds${toQuery({ status: f.status, paymentId: uuidOrNothing(f.paymentId), page: f.page, size: f.size })}`),

    /** `finance:settlement:any` (Module 07): read-only here; running a settlement is not offered. */
    settlements: (f: SettlementFilters = {}) =>
      get<SettlementPage>(`/admin/finance/settlements${toQuery({ status: f.status, page: f.page, size: f.size })}`),

    settlement: (id: string) => get<SettlementDetail>(`/admin/finance/settlements/${encodeURIComponent(id)}`),

    disputes: (f: DisputeFilters = {}) =>
      get<CodDisputePage>(`/admin/cod-disputes${toQuery({ status: f.status, orderId: uuidOrNothing(f.orderId), page: f.page, size: f.size })}`),

    dispute: (id: string) => get<CodDisputeDetail>(`/admin/cod-disputes/${encodeURIComponent(id)}`),

    /**
     * `finance:settlement:any`. Idempotent on the server: resolving a resolved dispute answers
     * `changed: false`. The actor comes from the session.
     */
    resolveDispute: (id: string, note?: string) =>
      request<CodDisputeResolution>(`/admin/cod-disputes/${encodeURIComponent(id)}/resolve`, {
        method: 'POST',
        body: note?.trim() ? { resolutionNote: note.trim() } : {},
      }),
  };
}

export const adminFinanceService = createAdminFinanceService(authService.request);
