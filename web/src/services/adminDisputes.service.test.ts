import { describe, expect, it, vi } from 'vitest';
import { createAdminDisputesService, NEXT_STATUSES } from './adminDisputes.service';
import type { SessionRequest } from './auth.service';

describe('adminDisputesService (Work 86)', () => {
  const setup = () => {
    const request = vi.fn().mockResolvedValue({});
    return { request, svc: createAdminDisputesService(request as unknown as SessionRequest, () => 'key-1') };
  };

  it('lists with status, overdue and mine; reads, updates and messages', async () => {
    const { request, svc } = setup();
    await svc.list({ status: 'OPEN', overdue: true, mine: true, page: 1, size: 25 });
    expect(request).toHaveBeenLastCalledWith('/admin/disputes?status=OPEN&overdue=true&mine=true&page=1&size=25', { method: 'GET' });
    await svc.list({ status: 'all' });
    expect(request).toHaveBeenLastCalledWith('/admin/disputes', { method: 'GET' });
    await svc.update('d1', { status: 'INVESTIGATING', assignToMe: true });
    expect(request).toHaveBeenLastCalledWith('/admin/disputes/d1', { method: 'PATCH', body: { status: 'INVESTIGATING', assignToMe: true } });
    await svc.message('d1', ' Looking into it ', true);
    expect(request).toHaveBeenLastCalledWith('/admin/disputes/d1/messages', { method: 'POST', body: { body: 'Looking into it', internal: true } });
  });

  it('resolves with an Idempotency-Key, sending an amount only for a refund', async () => {
    const { request, svc } = setup();
    await svc.resolve('d1', { action: 'REFUND', notes: ' Late ', amount: 1050 });
    expect(request).toHaveBeenLastCalledWith('/admin/disputes/d1/resolve', {
      method: 'POST',
      headers: { 'Idempotency-Key': 'key-1' },
      body: { action: 'REFUND', notes: 'Late', amount: 1050 },
    });
    await svc.resolve('d1', { action: 'NO_ACTION', notes: 'Fine', amount: 1050 });
    expect(request).toHaveBeenLastCalledWith('/admin/disputes/d1/resolve', {
      method: 'POST',
      headers: { 'Idempotency-Key': 'key-1' },
      body: { action: 'NO_ACTION', notes: 'Fine' },
    });
  });

  it('offers only the moves the server allows', () => {
    expect(NEXT_STATUSES.OPEN).toEqual(['INVESTIGATING', 'ESCALATED']);
    expect(NEXT_STATUSES.RESOLVED).toEqual(['CLOSED']);
    expect(NEXT_STATUSES.CLOSED).toBeUndefined();
  });
});
