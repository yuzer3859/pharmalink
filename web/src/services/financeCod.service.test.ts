import { describe, expect, it, vi } from 'vitest';
import type { SessionRequest } from './auth.service';
import { birrToSantim, codQuery, createFinanceCodService, remitProblem } from './financeCod.service';

describe('COD cash form rules (Work 127)', () => {
  it('reads birr into santim', () => {
    expect(birrToSantim('450')).toBe(45000);
    expect(birrToSantim('57,5')).toBe(5750);
    expect(birrToSantim('')).toBeNull();
    expect(birrToSantim('-1')).toBeNull();
    expect(birrToSantim('abc')).toBeNull();
  });

  it('needs an amount and a receipt reference within the server limit', () => {
    expect(remitProblem('450', 'RCPT-1')).toBeNull();
    expect(remitProblem('', 'RCPT-1')).not.toBeNull();
    expect(remitProblem('450', '  ')).not.toBeNull();
    expect(remitProblem('450', 'x'.repeat(129))).not.toBeNull();
  });

  it('sends only the filters set, capped at 50', () => {
    expect(codQuery({ status: 'all' })).toBe('');
    expect(codQuery({ status: 'COLLECTED', page: 1, size: 25 })).toBe('?status=COLLECTED&page=1&size=25');
    expect(codQuery({ size: 500 })).toBe('?size=50');
  });
});

describe('financeCodService', () => {
  it('lists, records the cash received and reconciles', async () => {
    const request = vi.fn().mockResolvedValue({});
    const s = createFinanceCodService(request as unknown as SessionRequest);
    await s.list({ status: 'COLLECTED', page: 1, size: 25 });
    expect(request).toHaveBeenLastCalledWith('/admin/delivery/cod-reconciliation?status=COLLECTED&page=1&size=25', { method: 'GET' });
    await s.remit('c/1', { remittedAmount: 45000, reference: ' RCPT-1 ', note: '  ' });
    expect(request).toHaveBeenLastCalledWith('/admin/delivery/cod-reconciliation/c%2F1/remit', { method: 'POST', body: { remittedAmount: 45000, reference: 'RCPT-1' } });
    await s.reconcile('c-1', { note: ' bank checked ' });
    expect(request).toHaveBeenLastCalledWith('/admin/delivery/cod-reconciliation/c-1/reconcile', { method: 'POST', body: { note: 'bank checked' } });
  });
});
