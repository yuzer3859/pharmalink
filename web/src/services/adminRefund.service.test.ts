import { describe, expect, it, vi } from 'vitest';
import { parseBirr } from './adminRefund.service';
import { createSettlementPayoutService } from './settlementPayout.service';
import type { SessionRequest } from './auth.service';

describe('parseBirr (Work 84)', () => {
  it('turns birr into santim without floating-point error', () => {
    expect(parseBirr('')).toBeNull();
    expect(parseBirr('10')).toBe(1000);
    expect(parseBirr('10.5')).toBe(1050);
    expect(parseBirr('0.07')).toBe(7);
    expect(parseBirr('19.99')).toBe(1999);
  });

  it('refuses anything else', () => {
    for (const bad of ['-1', '1,000', '1e3', '1.234', 'abc', '.5']) expect(parseBirr(bad)).toBeUndefined();
  });
});

describe('admin refund request (Work 84)', () => {
  it('posts to the gated admin route with a fresh key; an empty amount means everything', async () => {
    const request = vi.fn().mockResolvedValue({});
    const svc = createSettlementPayoutService(request as unknown as SessionRequest, () => 'key-1');
    await svc.refund('p/1', { amount: 1050, reason: ' Damaged ', destination: 'ORIGINAL' });
    expect(request).toHaveBeenLastCalledWith('/admin/finance/payments/p%2F1/refunds', {
      method: 'POST',
      headers: { 'Idempotency-Key': 'key-1' },
      body: { amount: 1050, reason: 'Damaged', destination: 'ORIGINAL' },
    });
    await svc.refund('p1', { reason: 'Whole order', destination: 'WALLET' });
    expect(request).toHaveBeenLastCalledWith('/admin/finance/payments/p1/refunds', {
      method: 'POST',
      headers: { 'Idempotency-Key': 'key-1' },
      body: { reason: 'Whole order', destination: 'WALLET' },
    });
  });
});
