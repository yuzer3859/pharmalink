import { describe, expect, it, vi } from 'vitest';
import type { SessionRequest } from './auth.service';
import { createFinanceStatementsService, runRequest, type SettlementDue } from './financeStatements.service';

const due = (over: Partial<SettlementDue> = {}): SettlementDue => ({
  pharmacyId: 'ph-1',
  pharmacyName: 'Seed Bole Pharmacy',
  currency: 'ETB',
  periodStart: '2026-11-05T03:09:25.991Z',
  periodEnd: '2026-11-10T08:00:00.000Z',
  netPayable: 1200,
  lineCount: 1,
  oldestLineAt: '2026-11-08T10:00:00.000Z',
  lastStatement: { settlementId: 's-0', periodEnd: '2026-11-05T03:09:25.991Z', status: 'DRAFT' },
  autoRunTrigger: null,
  ...over,
});

describe('runRequest (Work 125)', () => {
  it('runs the reported period, ending now', () => {
    const now = new Date('2026-11-10T09:00:00.000Z');
    expect(runRequest(due(), now)).toEqual({
      pharmacyId: 'ph-1',
      periodStart: '2026-11-05T03:09:25.991Z',
      periodEnd: '2026-11-10T09:00:00.000Z',
      currency: 'ETB',
    });
  });

  it('never ends before the period the server reported, even with a slow clock', () => {
    const now = new Date('2026-11-10T07:00:00.000Z');
    expect(runRequest(due(), now).periodEnd).toBe('2026-11-10T08:00:00.000Z');
  });
});

describe('financeStatementsService', () => {
  it('reads what is due, runs one, and reads the reconciliation', async () => {
    const request = vi.fn().mockResolvedValue({});
    const s = createFinanceStatementsService(request as unknown as SessionRequest);
    await s.due();
    expect(request).toHaveBeenLastCalledWith('/admin/finance/settlements/due', { method: 'GET' });
    await s.run(due());
    expect(request).toHaveBeenLastCalledWith('/admin/finance/settlements/run', {
      method: 'POST',
      body: expect.objectContaining({ pharmacyId: 'ph-1', periodStart: '2026-11-05T03:09:25.991Z', currency: 'ETB' }),
    });
    await s.reconciliation();
    expect(request).toHaveBeenLastCalledWith('/admin/finance/reconciliation', { method: 'GET' });
  });

  it('offers no approval or payout: those stay maker-checker in the statement drawer', () => {
    const s = createFinanceStatementsService(vi.fn() as unknown as SessionRequest);
    expect(Object.keys(s).sort()).toEqual(['due', 'reconciliation', 'run']);
  });
});
