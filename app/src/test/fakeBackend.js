import { vi } from 'vitest'

// A scripted stand-in for the backend: each route answers with the standard envelope. Nothing here
// talks to a network, a database or an e-mail provider.

export const REFRESH_A = 'r'.repeat(40)
export const REFRESH_B = 's'.repeat(40)

export const customer = {
  id: 'u-1',
  phone: null,
  email: 'meron@example.com',
  primaryRole: 'CUSTOMER',
  status: 'ACTIVE',
  preferredLanguage: 'en',
  phoneVerifiedAt: null,
  emailVerifiedAt: '2026-10-30T08:00:00.000Z',
  faydaVerified: false,
  deletionRequestedAt: null,
  roles: [{ roleKey: 'CUSTOMER', organizationId: null }],
  permissions: [],
}

export const tokens = (access = 'access-1', refresh = REFRESH_A) => ({
  accessToken: access,
  accessTokenExpiresAt: 1_900_000_000,
  refreshToken: refresh,
  refreshTokenExpiresAt: '2026-11-29T00:00:00.000Z',
})

export const ok = (data, status = 200) => ({ status, body: { success: true, data, error: null, meta: { requestId: 'req' } } })
export const fail = (status, code, message = 'nope', details) => ({
  status,
  body: { success: false, data: null, error: { code, message, ...(details ? { details } : {}) }, meta: { requestId: 'req' } },
})

/**
 * `routes` maps "METHOD /path" to a response, an array of responses (consumed in order) or a
 * function `(request) => response`. Every call is recorded with its parsed body and headers.
 */
export function fakeFetch(routes) {
  const calls = []
  const queues = new Map()
  const fetcher = vi.fn(async (url, init = {}) => {
    const path = new URL(url).pathname
    const key = `${init.method ?? 'GET'} ${path}`
    const request = { key, url, headers: init.headers ?? {}, body: init.body ? JSON.parse(init.body) : undefined }
    calls.push(request)
    let route = routes[key]
    if (Array.isArray(route)) {
      const index = queues.get(key) ?? 0
      queues.set(key, index + 1)
      route = route[Math.min(index, route.length - 1)]
    }
    if (typeof route === 'function') route = await route(request)
    if (!route) throw new Error(`unexpected request ${key}`)
    if (route === 'NETWORK') throw new TypeError('Failed to fetch')
    const { status, body, raw } = route
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => {
        if (raw !== undefined) throw new SyntaxError('Unexpected token')
        return body
      },
    }
  })
  return { fetcher, calls, callsTo: (key) => calls.filter((c) => c.key === key) }
}
