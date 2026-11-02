import { describe, expect, it, vi } from 'vitest';
import { ApiClient, ApiError } from './apiClient';
import { auditQuery, createAuditService, isActorIdFilter } from './audit.service';
import type { SessionRequest } from './auth.service';

const PAGE = {
  items: [
    {
      id: '6f1c2b1e-0c1d-4d7e-9a43-1b2c3d4e5f60',
      action: 'CONFIG_CHANGED',
      resourceType: 'PlatformConfig',
      resourceId: 'orders/cancellationWindowMinutes',
      actorUserId: null,
      context: { from: 10, to: 15 },
      ip: null,
      createdAt: '2026-11-02T08:00:00.000Z',
      chain: { prevHash: null, hash: 'a'.repeat(64) },
    },
  ],
  total: 1,
  page: 1,
  size: 25,
};

describe('auditQuery', () => {
  it('sends only the filters that are set, trimmed, with page and size', () => {
    expect(auditQuery({})).toBe('');
    expect(auditQuery({ action: '  CONFIG_CHANGED ', resourceType: '', actorUserId: '   ', page: 2, size: 50 })).toBe(
      '?action=CONFIG_CHANGED&page=2&size=50',
    );
  });

  it('encodes values', () => {
    expect(auditQuery({ resourceId: 'orders/a b', from: '2026-11-01T00:00:00.000Z' })).toBe(
      '?resourceId=orders%2Fa+b&from=2026-11-01T00%3A00%3A00.000Z',
    );
  });
});

describe('isActorIdFilter', () => {
  it('accepts a UUID only, as the API does', () => {
    expect(isActorIdFilter('6f1c2b1e-0c1d-4d7e-9a43-1b2c3d4e5f60')).toBe(true);
    expect(isActorIdFilter(' 6F1C2B1E-0C1D-4D7E-9A43-1B2C3D4E5F60 ')).toBe(true);
    expect(isActorIdFilter('6f1c2b1e')).toBe(false);
    expect(isActorIdFilter('admin@example.com')).toBe(false);
  });
});

describe('auditService', () => {
  it('reads GET /admin/audit on the session and returns the page as the server sent it', async () => {
    const request = vi.fn().mockResolvedValue(PAGE);
    const service = createAuditService(request as unknown as SessionRequest);

    await expect(service.list({ action: 'CONFIG_CHANGED', page: 1, size: 25 })).resolves.toEqual(PAGE);
    expect(request).toHaveBeenCalledWith('/admin/audit?action=CONFIG_CHANGED&page=1&size=25', { method: 'GET' });
  });

  it('reads one entry by its id, encoded', async () => {
    const request = vi.fn().mockResolvedValue({ ...PAGE.items[0], chain: { ...PAGE.items[0].chain, hashValid: true } });
    const service = createAuditService(request as unknown as SessionRequest);

    await service.get('id/with slash');
    expect(request).toHaveBeenCalledWith('/admin/audit/id%2Fwith%20slash', { method: 'GET' });
  });

  it('has no write method: the explorer is read-only', () => {
    const service = createAuditService(vi.fn() as unknown as SessionRequest);
    expect(Object.keys(service).sort()).toEqual(['get', 'list']);
  });
});

describe('the API client the audit service rides on', () => {
  const respond = (status: number, body: unknown) =>
    vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));

  it('unwraps the success envelope and sends the bearer token', async () => {
    const fetcher = respond(200, { success: true, data: PAGE, error: null });
    const client = new ApiClient('http://api.test/api/v1', fetcher);

    await expect(client.request('/admin/audit?page=1', { method: 'GET', accessToken: 'token-1' })).resolves.toEqual(PAGE);
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe('http://api.test/api/v1/admin/audit?page=1');
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer token-1');
  });

  it('turns an error envelope into an ApiError with status, code and request id', async () => {
    const fetcher = respond(403, {
      success: false,
      data: null,
      error: { code: 'FORBIDDEN', message: 'Missing permission audit:read:any' },
      meta: { requestId: 'req-9' },
    });
    const client = new ApiClient('http://api.test/api/v1', fetcher);

    const failure = await client.request('/admin/audit', { method: 'GET' }).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ApiError);
    expect(failure).toMatchObject({ status: 403, code: 'FORBIDDEN', requestId: 'req-9' });
  });
});
