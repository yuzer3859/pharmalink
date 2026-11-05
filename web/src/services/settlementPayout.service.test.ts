import { describe, expect, it, vi } from 'vitest';
import { createSettlementPayoutService, gatedMessage } from './settlementPayout.service';
import type { SessionRequest } from './auth.service';

const service = () => {
  const request = vi.fn().mockResolvedValue({});
  let n = 0;
  return { request, svc: createSettlementPayoutService(request as unknown as SessionRequest, () => `key-${++n}`) };
};

describe('settlementPayoutService (Work 83)', () => {
  it('sends approve, pay and verify with a fresh Idempotency-Key and an optional trimmed reason', async () => {
    const { request, svc } = service();
    await svc.approve('s/1', '  Month end ');
    expect(request).toHaveBeenLastCalledWith('/admin/finance/settlements/s%2F1/approve', {
      method: 'POST',
      headers: { 'Idempotency-Key': 'key-1' },
      body: { reason: 'Month end' },
    });
    await svc.pay('s1');
    expect(request).toHaveBeenLastCalledWith('/admin/finance/settlements/s1/pay', {
      method: 'POST',
      headers: { 'Idempotency-Key': 'key-2' },
      body: {},
    });
    await svc.verifyBeneficiary('b1', ' ');
    expect(request).toHaveBeenLastCalledWith('/admin/finance/payout-beneficiaries/b1/verify', {
      method: 'POST',
      headers: { 'Idempotency-Key': 'key-3' },
      body: {},
    });
  });

  it('reads the payout, refreshes it, and lists destinations', async () => {
    const { request, svc } = service();
    await svc.payout('s1');
    expect(request).toHaveBeenLastCalledWith('/admin/finance/settlements/s1/payout', { method: 'GET' });
    await svc.refresh('s1');
    expect(request).toHaveBeenLastCalledWith('/admin/finance/settlements/s1/payout/refresh', { method: 'POST', body: {} });
    await svc.beneficiaries('p1');
    expect(request).toHaveBeenLastCalledWith('/admin/finance/pharmacies/p1/payout-beneficiaries', { method: 'GET' });
  });

  it('registers a destination, sending a bank code only for a bank transfer', async () => {
    const { request, svc } = service();
    await svc.registerBeneficiary('p1', { rail: 'TELEBIRR', accountName: ' Seed ', bankCode: 'CBE', accountIdentifier: ' 0911223344 ' });
    expect(request).toHaveBeenLastCalledWith('/admin/finance/pharmacies/p1/payout-beneficiaries', {
      method: 'POST',
      body: { rail: 'TELEBIRR', accountName: 'Seed', accountIdentifier: '0911223344' },
    });
    await svc.registerBeneficiary('p1', { rail: 'BANK_TRANSFER', accountName: 'Seed', bankCode: ' cbe ', accountIdentifier: '100012345678' });
    expect(request).toHaveBeenLastCalledWith('/admin/finance/pharmacies/p1/payout-beneficiaries', {
      method: 'POST',
      body: { rail: 'BANK_TRANSFER', accountName: 'Seed', accountIdentifier: '100012345678', bankCode: 'cbe' },
    });
  });

  it('tells the operator when a second officer must approve', () => {
    expect(gatedMessage({ outcome: 'MAKER_CHECKER_PENDING', approval: {} as never }, 'Done.')).toMatch(/different finance officer/);
    expect(gatedMessage({ outcome: 'EXECUTED', result: {} }, 'Done.')).toBe('Done.');
  });
});
