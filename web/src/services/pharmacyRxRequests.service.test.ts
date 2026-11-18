import { describe, expect, it, vi } from 'vitest';
import type { SessionRequest } from './auth.service';
import {
  createPharmacyRxRequestsService,
  quoteProblem,
  reasonProblem,
  rxRequestActions,
  rxRequestQuery,
  rxRequestStage,
  type PharmacyRxRequest,
} from './pharmacyRxRequests.service';

const r = (status: PharmacyRxRequest['status'], offer: PharmacyRxRequest['offer']['status'], mine = false) => ({
  status,
  mine,
  offer: { status: offer, branchId: 'b', distanceMeters: 500, respondedAt: null },
});

const quote = { lines: [{ catalogProductId: 'p-1', quantity: 2 }], prescriptionIssueDate: '2026-11-18', legibilityOk: true, validityOk: true };

describe('rxRequestActions (Work 137)', () => {
  it('accept or decline while it is open to this pharmacy; quote or let go once it holds it; nothing otherwise', () => {
    expect(rxRequestActions(r('OPEN', 'OPEN'))).toEqual(['accept', 'decline']);
    expect(rxRequestActions(r('CLAIMED', 'WON', true))).toEqual(['quote', 'release']);
    expect(rxRequestActions(r('CLAIMED', 'TAKEN'))).toEqual([]);
    expect(rxRequestActions(r('OPEN', 'DECLINED'))).toEqual([]);
    expect(rxRequestActions(r('QUOTED', 'WON', true))).toEqual([]);
  });

  it('says where it is in plain words', () => {
    expect(rxRequestStage(r('CLAIMED', 'TAKEN'))).toMatch(/another pharmacy/);
    expect(rxRequestStage(r('CLAIMED', 'WON', true))).toMatch(/send the medicines/);
    expect(rxRequestStage(r('OPEN', 'LAPSED'))).toMatch(/Not quoted in time/);
    for (const s of ['OPEN', 'QUOTED', 'CONFIRMED', 'CANCELLED', 'EXPIRED', 'NO_PHARMACY'] as const) expect(rxRequestStage(r(s, 'OPEN')).length).toBeGreaterThan(3);
  });
});

describe('the form checks', () => {
  it('quotes: a medicine at least once each, whole quantities, the date, both attestations', () => {
    expect(quoteProblem(quote)).toBeNull();
    expect(quoteProblem({ ...quote, lines: [] })).not.toBeNull();
    expect(quoteProblem({ ...quote, lines: [...quote.lines, ...quote.lines] })).toMatch(/once/);
    expect(quoteProblem({ ...quote, lines: [{ catalogProductId: 'p-1', quantity: 0 }] })).not.toBeNull();
    expect(quoteProblem({ ...quote, prescriptionIssueDate: '' })).toMatch(/date/);
    expect(quoteProblem({ ...quote, validityOk: false })).toMatch(/legible and valid/);
  });

  it('reasons: 3 to 500 characters', () => {
    expect(reasonProblem(' ab ')).not.toBeNull();
    expect(reasonProblem('Out of stock')).toBeNull();
    expect(reasonProblem('x'.repeat(501))).not.toBeNull();
  });
});

describe('pharmacyRxRequestsService', () => {
  it('reads the list and one request, and asks for the file link', async () => {
    const request = vi.fn().mockResolvedValue({ items: [], total: 0 });
    const service = createPharmacyRxRequestsService(request as unknown as SessionRequest);
    expect(rxRequestQuery('all', 2, 200)).toBe('?scope=all&page=2&size=50');

    await service.list();
    expect(request).toHaveBeenLastCalledWith('/pharmacy/rx-requests?scope=active', { method: 'GET' });
    await service.get('r/1');
    expect(request).toHaveBeenLastCalledWith('/pharmacy/rx-requests/r%2F1', { method: 'GET' });
    await service.fileLink('r-1');
    expect(request).toHaveBeenLastCalledWith('/pharmacy/rx-requests/r-1/file', { method: 'POST' });
  });

  it('posts each decision to its route', async () => {
    const request = vi.fn().mockResolvedValue({});
    const service = createPharmacyRxRequestsService(request as unknown as SessionRequest);
    await service.accept('r-1');
    expect(request).toHaveBeenLastCalledWith('/pharmacy/rx-requests/r-1/accept', { method: 'POST' });
    await service.decline('r-1', '  Not stocked ');
    expect(request).toHaveBeenLastCalledWith('/pharmacy/rx-requests/r-1/decline', { method: 'POST', body: { reason: 'Not stocked' } });
    await service.release('r-1', ' Ran out ');
    expect(request).toHaveBeenLastCalledWith('/pharmacy/rx-requests/r-1/release', { method: 'POST', body: { reason: 'Ran out' } });
    await service.quote('r-1', { ...quote, note: '  Generic brand ', paperRequired: true });
    expect(request).toHaveBeenLastCalledWith('/pharmacy/rx-requests/r-1/quote', { method: 'POST', body: { ...quote, paperRequired: true, note: 'Generic brand' } });
  });
});
