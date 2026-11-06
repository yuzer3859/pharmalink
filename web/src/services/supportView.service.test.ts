import { describe, expect, it, vi } from 'vitest';
import { createSupportViewService } from './supportView.service';
import type { SessionRequest } from './auth.service';

describe('supportViewService (Work 85)', () => {
  const setup = () => {
    const request = vi.fn().mockResolvedValue({});
    const client = { request: vi.fn().mockResolvedValue({ items: [], total: 0 }) };
    const svc = createSupportViewService(request as unknown as SessionRequest, client as never, () => 'key-1');
    return { request, client, svc };
  };

  it('asks with a trimmed reason and an Idempotency-Key, and manages sessions', async () => {
    const { request, svc } = setup();
    await svc.request('u/1', '  Cannot see order ');
    expect(request).toHaveBeenLastCalledWith('/admin/accounts/u%2F1/impersonate', {
      method: 'POST',
      headers: { 'Idempotency-Key': 'key-1' },
      body: { reason: 'Cannot see order' },
    });
    await svc.sessions('u1');
    expect(request).toHaveBeenLastCalledWith('/admin/impersonation-sessions?targetUserId=u1', { method: 'GET' });
    await svc.start('s1');
    expect(request).toHaveBeenLastCalledWith('/admin/impersonation-sessions/s1/start', { method: 'POST', body: {} });
    await svc.end('s1');
    expect(request).toHaveBeenLastCalledWith('/admin/impersonation-sessions/s1/end', { method: 'POST', body: {} });
  });

  it('reads the account with the session token only, GET only, without refreshing', async () => {
    const { client, svc } = setup();
    await svc.snapshot('imp-token');
    for (const call of client.request.mock.calls) {
      expect(call[1]).toEqual({ method: 'GET', accessToken: 'imp-token', retryAuth: false });
    }
    expect(client.request.mock.calls.map((c) => c[0])).toEqual(['/users/me', '/orders?page=1&size=5']);
  });
});
