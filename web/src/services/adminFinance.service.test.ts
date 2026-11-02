import { describe, expect, it, vi } from 'vitest';
import { ApiError } from './apiClient';
import { createAdminFinanceService, financeErrorMessage, isUuid, toQuery } from './adminFinance.service';
import type { SessionRequest } from './auth.service';

const ORDER = '9dfeae75-0678-4587-8338-2c040e225bdf';

const service = () => {
  const request = vi.fn().mockResolvedValue({});
  return { request, svc: createAdminFinanceService(request as unknown as SessionRequest) };
};

describe('toQuery', () => {
  it('leaves out undefined, empty and "all"; trims the rest', () => {
    expect(toQuery({})).toBe('');
    expect(toQuery({ status: 'all', orderId: '  ', page: undefined })).toBe('');
    expect(toQuery({ status: 'CAPTURED', method: ' COD ', page: 2, size: 25 })).toBe('?status=CAPTURED&method=COD&page=2&size=25');
  });
});

describe('isUuid', () => {
  it('accepts a UUID only', () => {
    expect(isUuid(ORDER)).toBe(true);
    expect(isUuid(` ${ORDER.toUpperCase()} `)).toBe(true);
    expect(isUuid('9dfeae75')).toBe(false);
  });
});

describe('adminFinanceService reads', () => {
  it('overview, payments (order id only when a UUID), one payment and refunds', async () => {
    const { request, svc } = service();
    await svc.overview();
    expect(request).toHaveBeenLastCalledWith('/admin/finance/overview', { method: 'GET' });
    await svc.payments({ status: 'CAPTURED', method: 'all', orderId: ORDER, page: 1, size: 25 });
    expect(request).toHaveBeenLastCalledWith(`/admin/finance/payments?status=CAPTURED&orderId=${ORDER}&page=1&size=25`, { method: 'GET' });
    await svc.payments({ orderId: 'not-a-uuid' });
    expect(request).toHaveBeenLastCalledWith('/admin/finance/payments', { method: 'GET' });
    await svc.payment('p/1');
    expect(request).toHaveBeenLastCalledWith('/admin/finance/payments/p%2F1', { method: 'GET' });
    await svc.refunds({ status: 'PENDING' });
    expect(request).toHaveBeenLastCalledWith('/admin/finance/refunds?status=PENDING', { method: 'GET' });
  });

  it('settlements and disputes', async () => {
    const { request, svc } = service();
    await svc.settlements({ status: 'DRAFT', page: 1, size: 10 });
    expect(request).toHaveBeenLastCalledWith('/admin/finance/settlements?status=DRAFT&page=1&size=10', { method: 'GET' });
    await svc.settlement('s1');
    expect(request).toHaveBeenLastCalledWith('/admin/finance/settlements/s1', { method: 'GET' });
    await svc.disputes({ status: 'OPEN', orderId: ORDER });
    expect(request).toHaveBeenLastCalledWith(`/admin/cod-disputes?status=OPEN&orderId=${ORDER}`, { method: 'GET' });
    await svc.dispute('d1');
    expect(request).toHaveBeenLastCalledWith('/admin/cod-disputes/d1', { method: 'GET' });
  });

  it('offers no settlement run, approval or payout', () => {
    const { svc } = service();
    expect(Object.keys(svc).sort()).toEqual(
      ['dispute', 'disputes', 'overview', 'payment', 'payments', 'refunds', 'resolveDispute', 'settlement', 'settlements'].sort(),
    );
  });
});

describe('resolveDispute', () => {
  it('sends a trimmed note, or no note at all', async () => {
    const { request, svc } = service();
    await svc.resolveDispute('d1', '  Driver remitted the difference  ');
    expect(request).toHaveBeenLastCalledWith('/admin/cod-disputes/d1/resolve', {
      method: 'POST',
      body: { resolutionNote: 'Driver remitted the difference' },
    });
    await svc.resolveDispute('d1', '   ');
    expect(request).toHaveBeenLastCalledWith('/admin/cod-disputes/d1/resolve', { method: 'POST', body: {} });
  });
});

describe('financeErrorMessage', () => {
  it('maps permission and missing-record errors', () => {
    expect(financeErrorMessage(new ApiError(403, 'FORBIDDEN', 'x'), 'f')).toMatch(/not allowed/);
    expect(financeErrorMessage(new ApiError(404, 'NOT_FOUND', 'x'), 'f')).toMatch(/no longer exists/);
    expect(financeErrorMessage(new ApiError(422, 'BUSINESS_RULE_VIOLATION', 'Closed collection'), 'f')).toBe('Closed collection');
    expect(financeErrorMessage(new Error('x'), 'fallback')).toBe('fallback');
  });
});
