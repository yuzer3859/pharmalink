import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiClient } from './apiClient';

describe('ApiClient default fetcher', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('calls the global fetch without the client as its receiver', async () => {
    // Mirrors the browser: fetch throws "Illegal invocation" unless called on the global object.
    const browserLikeFetch = vi.fn(function (this: unknown) {
      if (this !== undefined && this !== globalThis) {
        return Promise.reject(new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation"));
      }
      return Promise.resolve(
        new Response(JSON.stringify({ success: true, data: { ok: true }, error: null }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    });
    vi.stubGlobal('fetch', browserLikeFetch);

    const client = new ApiClient('http://api.test');

    await expect(client.request('/auth/login', { method: 'POST', body: {} })).resolves.toEqual({ ok: true });
    expect(browserLikeFetch).toHaveBeenCalledWith('http://api.test/auth/login', expect.any(Object));
  });
});
