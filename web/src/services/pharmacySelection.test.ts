import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiClient } from './apiClient';
import { onOrganizationSelected, selectedOrganizationId, selectOrganization } from './pharmacySelection';
import { createMyPharmaciesService } from './myPharmacies.service';
import type { SessionRequest } from './auth.service';

const ORG = '66666666-6666-4666-8666-666666666666';

describe('working in one of several pharmacies (Work 155)', () => {
  afterEach(() => selectOrganization(null));

  it('remembers a valid choice on this device, tells listeners, and refuses anything else', () => {
    const stored = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => stored.get(k) ?? null,
      setItem: (k: string, v: string) => void stored.set(k, v),
      removeItem: (k: string) => void stored.delete(k),
    });
    const heard = vi.fn();
    const stop = onOrganizationSelected(heard);
    selectOrganization(ORG);
    expect(selectedOrganizationId()).toBe(ORG);
    expect(localStorage.getItem('pharmalink.portal.organizationId')).toBe(ORG);
    selectOrganization('not-an-id');
    expect(selectedOrganizationId()).toBeNull();
    expect(localStorage.getItem('pharmalink.portal.organizationId')).toBeNull();
    expect(heard).toHaveBeenCalledTimes(2);
    stop();
    vi.unstubAllGlobals();
  });

  it('still works where nothing can be remembered', () => {
    selectOrganization(ORG);
    expect(selectedOrganizationId()).toBe(ORG);
  });

  it('sends the chosen pharmacy with signed-in requests only', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ success: true, data: {} }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const client = new ApiClient('http://api.test', fetcher as unknown as typeof fetch);
    selectOrganization(ORG);
    await client.request('/pharmacy/profile', { method: 'GET', accessToken: 'token' });
    expect((fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].headers).toBeInstanceOf(Headers);
    expect(((fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].headers as Headers).get('X-Organization-Id')).toBe(ORG);
    await client.request('/catalog/products', { method: 'GET' });
    expect(((fetcher.mock.calls[1] as unknown as [string, RequestInit])[1].headers as Headers).get('X-Organization-Id')).toBeNull();
  });

  it('lists the pharmacies the account works in', async () => {
    const request = vi.fn(async () => []) as unknown as SessionRequest;
    await createMyPharmaciesService(request).list();
    expect(request).toHaveBeenCalledWith('/pharmacy/mine', { method: 'GET' });
  });
});
