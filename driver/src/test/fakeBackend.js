import { vi } from 'vitest'

// A scripted stand-in for the backend: each route answers with the standard envelope. Nothing here
// talks to a network or a database.

export const REFRESH_A = 'r'.repeat(40)

export const driverUser = {
  id: 'd-1',
  phone: '+251910000104',
  email: 'driver.walk@staging.pharmalink.test',
  primaryRole: 'DRIVER',
  status: 'ACTIVE',
  roles: [{ roleKey: 'DRIVER', organizationId: null }],
  permissions: ['delivery:read:own', 'delivery:update:own', 'delivery:accept:own'],
}

export const driverProfile = (over = {}) => ({
  userId: 'd-1',
  availability: 'OFFLINE',
  onShift: false,
  shiftStartedAt: null,
  vehicle: { type: 'MOTORCYCLE', plateNumber: 'AA-3-STG80' },
  serviceArea: { lat: 9.0108, lng: 38.7613, radiusMeters: 20000 },
  maxConcurrent: 5,
  lastLocation: null,
  verification: { isEligible: true, reason: null, documentsExpireAt: null },
  ...over,
})

export const tokens = (access = 'access-1', refresh = REFRESH_A) => ({ accessToken: access, refreshToken: refresh })

export const ok = (data, status = 200) => ({ status, body: { success: true, data, error: null, meta: { requestId: 'req' } } })
export const fail = (status, code, message = 'nope') => ({
  status,
  body: { success: false, data: null, error: { code, message }, meta: { requestId: 'req' } },
})

/** `routes` maps "METHOD /path" to a response, a list consumed in order, or `(request) => response`. */
export function fakeFetch(routes) {
  const calls = []
  const queues = new Map()
  const fetcher = vi.fn(async (url, init = {}) => {
    const path = new URL(url).pathname
    const key = `${init.method ?? 'GET'} ${path}`
    const request = { key, url, headers: init.headers ?? {}, body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body }
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
    return { ok: route.status >= 200 && route.status < 300, status: route.status, json: async () => route.body }
  })
  return { fetcher, calls, callsTo: (key) => calls.filter((c) => c.key === key) }
}
