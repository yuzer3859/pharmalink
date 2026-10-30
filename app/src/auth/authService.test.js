import { describe, expect, it } from 'vitest'
import { resolveApiBaseUrl } from '../config/env'
import { ApiError, createApiClient } from './apiClient'
import { createAuthService } from './authService'
import { describeAuthError, retryAfterSeconds } from './errors'
import { REFRESH_A, REFRESH_B, customer, fail, fakeFetch, ok, tokens } from '../test/fakeBackend'

const BASE = 'http://api.test'
const device = () => ({ fingerprint: 'device-1', platform: 'WEB', name: 'PharmaLink web' })

function setup(routes, storage = sessionStorage) {
  const backend = fakeFetch(routes)
  const service = createAuthService({ api: createApiClient({ baseUrl: BASE, fetcher: backend.fetcher }), storage, deviceInfo: device })
  return { ...backend, service }
}

const stored = () => JSON.parse(sessionStorage.getItem('pharmalink.customer.session') ?? 'null')

describe('API base URL', () => {
  it('defaults to the local backend and trims trailing slashes', () => {
    expect(resolveApiBaseUrl(undefined)).toBe('http://localhost:3000')
    expect(resolveApiBaseUrl('  ')).toBe('http://localhost:3000')
    expect(resolveApiBaseUrl('https://staging.example.test/')).toBe('https://staging.example.test')
  })
})

describe('API client', () => {
  it('unwraps the success envelope and sends JSON with the bearer token', async () => {
    const { fetcher, calls } = fakeFetch({ 'POST /x': ok({ a: 1 }) })
    const api = createApiClient({ baseUrl: BASE, fetcher })
    await expect(api.post('/x', { b: 2 }, { accessToken: 'tok' })).resolves.toEqual({ a: 1 })
    expect(calls[0].url).toBe('http://api.test/x')
    expect(calls[0].headers).toMatchObject({ Authorization: 'Bearer tok', 'Content-Type': 'application/json' })
    expect(calls[0].body).toEqual({ b: 2 })
  })

  it('turns an error envelope into an ApiError with code, message and details', async () => {
    const { fetcher } = fakeFetch({ 'GET /x': fail(429, 'RATE_LIMITED', 'slow down', { retryAfterSeconds: 12 }) })
    const error = await createApiClient({ baseUrl: BASE, fetcher }).get('/x').catch((e) => e)
    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({ status: 429, code: 'RATE_LIMITED', message: 'slow down', details: { retryAfterSeconds: 12 } })
  })

  it('reports network failures, non-JSON errors and malformed success bodies distinctly', async () => {
    const { fetcher } = fakeFetch({ 'GET /net': 'NETWORK', 'GET /html': { status: 502, raw: '<html>' }, 'GET /odd': { status: 200, body: { hello: 1 } } })
    const api = createApiClient({ baseUrl: BASE, fetcher })
    await expect(api.get('/net')).rejects.toMatchObject({ status: 0, code: 'NETWORK_ERROR' })
    await expect(api.get('/html')).rejects.toMatchObject({ status: 502, code: 'HTTP_ERROR' })
    await expect(api.get('/odd')).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
  })
})

describe('registration and e-mail verification', () => {
  it('registers with only the supported fields and returns the masked target', async () => {
    const { service, calls } = setup({
      'POST /auth/register': ok({ userId: 'u-1', status: 'PENDING_VERIFICATION', verification: { channel: 'EMAIL', target: 'm***@example.com' } }, 201),
    })
    const result = await service.register({ email: 'meron@example.com', password: 'Passw0rd!', preferredLanguage: 'am' })
    expect(result.verification.target).toBe('m***@example.com')
    expect(calls[0].body).toEqual({ email: 'meron@example.com', password: 'Passw0rd!', preferredLanguage: 'am' })
    expect(service.hasStoredSession()).toBe(false)
  })

  it('surfaces the truthful delivery-unavailable error instead of pretending a code was sent', async () => {
    const { service } = setup({
      'POST /auth/register': fail(503, 'DEPENDENCY_UNAVAILABLE', 'E-mail delivery is not configured', { channel: 'EMAIL', reason: 'NOT_CONFIGURED' }),
    })
    const error = await service.register({ email: 'a@b.co', password: 'Passw0rd!', preferredLanguage: 'en' }).catch((e) => e)
    expect(describeAuthError(error)).toMatch(/not set up.*no code was sent/i)
  })

  it('rejects a malformed registration response', async () => {
    const { service } = setup({ 'POST /auth/register': ok({ userId: 'u-1' }, 201) })
    await expect(service.register({ email: 'a@b.co', password: 'x', preferredLanguage: 'en' })).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
  })

  it('verifies with purpose REGISTER and a WEB device, stores the session and loads the customer', async () => {
    const { service, calls, callsTo } = setup({
      'POST /auth/verify-otp': ok({ verified: true, tokens: tokens() }),
      'GET /users/me': ok(customer),
    })
    const user = await service.verifyRegistration({ email: 'meron@example.com', code: '123456' })
    expect(user.email).toBe('meron@example.com')
    expect(calls[0].body).toEqual({
      identifier: 'meron@example.com',
      code: '123456',
      purpose: 'REGISTER',
      deviceInfo: { fingerprint: 'device-1', platform: 'WEB', name: 'PharmaLink web' },
    })
    expect(callsTo('GET /users/me')[0].headers.Authorization).toBe('Bearer access-1')
    // Only the refresh token is persisted, in sessionStorage; never the access token or the code.
    expect(stored()).toEqual({ refreshToken: REFRESH_A })
    expect(JSON.stringify(sessionStorage) + JSON.stringify(localStorage)).not.toContain('123456')
    expect(JSON.stringify(localStorage)).not.toContain(REFRESH_A)
  })

  it('maps invalid, expired and exhausted codes to distinct messages', async () => {
    const { service } = setup({
      'POST /auth/verify-otp': [fail(400, 'AUTH_OTP_INVALID'), fail(410, 'AUTH_OTP_EXPIRED'), fail(429, 'AUTH_OTP_ATTEMPTS_EXCEEDED')],
    })
    const messages = []
    for (let i = 0; i < 3; i += 1) {
      messages.push(describeAuthError(await service.verifyRegistration({ email: 'a@b.co', code: '000000' }).catch((e) => e)))
    }
    expect(messages[0]).toMatch(/not correct/)
    expect(messages[1]).toMatch(/expired/)
    expect(messages[2]).toMatch(/too many incorrect/i)
    expect(service.hasStoredSession()).toBe(false)
  })

  it('treats a verification without tokens as malformed rather than signed in', async () => {
    const { service } = setup({ 'POST /auth/verify-otp': ok({ verified: true }) })
    await expect(service.verifyRegistration({ email: 'a@b.co', code: '123456' })).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
    expect(service.hasStoredSession()).toBe(false)
  })

  it('resends with purpose REGISTER and returns the backend cooldown; a cooldown error carries retryAfterSeconds', async () => {
    const { service, calls } = setup({
      'POST /auth/resend-otp': [ok({ resent: true, cooldownSeconds: 30 }), fail(429, 'RATE_LIMITED', 'wait', { retryAfterSeconds: 27 })],
    })
    await expect(service.resendRegistrationCode('a@b.co')).resolves.toEqual({ cooldownSeconds: 30 })
    expect(calls[0].body).toEqual({ identifier: 'a@b.co', purpose: 'REGISTER' })
    const error = await service.resendRegistrationCode('a@b.co').catch((e) => e)
    expect(retryAfterSeconds(error)).toBe(27)
    expect(describeAuthError(error)).toBe('Try again in 27 s.')
  })
})

describe('login, session and logout', () => {
  it('logs in with identifier, password and device, then loads /users/me', async () => {
    const { service, calls } = setup({ 'POST /auth/login': ok(tokens()), 'GET /users/me': ok(customer) })
    await expect(service.login({ email: 'meron@example.com', password: 'Passw0rd!' })).resolves.toMatchObject({ id: 'u-1' })
    expect(calls[0].body).toEqual({ identifier: 'meron@example.com', password: 'Passw0rd!', deviceInfo: device() })
    expect(service.hasStoredSession()).toBe(true)
  })

  it('maps invalid credentials and a suspended account', async () => {
    const { service } = setup({ 'POST /auth/login': [fail(401, 'AUTH_INVALID_CREDENTIALS'), fail(403, 'AUTH_ACCOUNT_SUSPENDED')] })
    expect(describeAuthError(await service.login({ email: 'a@b.co', password: 'x' }).catch((e) => e))).toMatch(/incorrect/)
    expect(describeAuthError(await service.login({ email: 'a@b.co', password: 'x' }).catch((e) => e))).toMatch(/suspended/)
  })

  it('signs a staff account straight back out and refuses it', async () => {
    const { service, callsTo } = setup({
      'POST /auth/login': ok(tokens()),
      'GET /users/me': ok({ ...customer, primaryRole: 'PHARMACY_OWNER' }),
      'POST /auth/logout': { status: 204 },
    })
    await expect(service.login({ email: 'staff@example.com', password: 'x' })).rejects.toMatchObject({ code: 'NOT_CUSTOMER' })
    expect(callsTo('POST /auth/logout')[0].body).toEqual({ refreshToken: REFRESH_A })
    expect(service.hasStoredSession()).toBe(false)
  })

  it('refreshes once on an expired access token, rotates the stored refresh token and retries', async () => {
    const { service, callsTo } = setup({
      'POST /auth/login': ok(tokens()),
      'GET /users/me': [ok(customer), fail(401, 'TOKEN_EXPIRED'), ok(customer)],
      'POST /auth/token/refresh': ok(tokens('access-2', REFRESH_B)),
    })
    await service.login({ email: 'a@b.co', password: 'x' })
    await expect(service.fetchCustomer()).resolves.toMatchObject({ id: 'u-1' })
    expect(callsTo('POST /auth/token/refresh')[0].body).toEqual({ refreshToken: REFRESH_A })
    expect(callsTo('GET /users/me')[2].headers.Authorization).toBe('Bearer access-2')
    expect(stored()).toEqual({ refreshToken: REFRESH_B })
  })

  it('never sends two refreshes at once (rotation race)', async () => {
    let release
    const gate = new Promise((resolve) => { release = resolve })
    sessionStorage.setItem('pharmalink.customer.session', JSON.stringify({ refreshToken: REFRESH_A }))
    const { service, callsTo } = setup({
      'POST /auth/token/refresh': async () => { await gate; return ok(tokens('access-2', REFRESH_B)) },
      'GET /users/me': ok(customer),
    })
    const both = Promise.all([service.fetchCustomer(), service.fetchCustomer()])
    release()
    await both
    expect(callsTo('POST /auth/token/refresh')).toHaveLength(1)
  })

  it('restores a stored session once per page load, even when asked twice', async () => {
    sessionStorage.setItem('pharmalink.customer.session', JSON.stringify({ refreshToken: REFRESH_A }))
    const { service, callsTo } = setup({ 'POST /auth/token/refresh': ok(tokens('access-2', REFRESH_B)), 'GET /users/me': ok(customer) })
    const [a, b] = await Promise.all([service.restore(), service.restore()])
    expect(a).toEqual(customer)
    expect(b).toEqual(customer)
    expect(callsTo('POST /auth/token/refresh')).toHaveLength(1)
  })

  it('clears the session and notifies listeners when the backend rejects the refresh token', async () => {
    sessionStorage.setItem('pharmalink.customer.session', JSON.stringify({ refreshToken: REFRESH_A }))
    const { service } = setup({ 'POST /auth/token/refresh': fail(401, 'AUTH_REFRESH_REUSE_DETECTED') })
    let expired = 0
    service.onSessionExpired(() => { expired += 1 })
    await expect(service.restore()).resolves.toBeNull()
    expect(expired).toBe(1)
    expect(stored()).toBeNull()
    expect(service.hasStoredSession()).toBe(false)
  })

  it('keeps the stored session when the refresh fails only because the network is down', async () => {
    sessionStorage.setItem('pharmalink.customer.session', JSON.stringify({ refreshToken: REFRESH_A }))
    const { service } = setup({ 'POST /auth/token/refresh': 'NETWORK' })
    await expect(service.restore()).rejects.toMatchObject({ code: 'NETWORK_ERROR' })
    expect(stored()).toEqual({ refreshToken: REFRESH_A })
  })

  it('logs out on the server with the refresh token and clears local state, even if the server is unreachable', async () => {
    const { service, callsTo } = setup({ 'POST /auth/login': ok(tokens()), 'GET /users/me': ok(customer), 'POST /auth/logout': { status: 204 } })
    await service.login({ email: 'a@b.co', password: 'x' })
    await service.logout()
    expect(callsTo('POST /auth/logout')[0].headers.Authorization).toBe('Bearer access-1')
    expect(stored()).toBeNull()

    const offline = setup({ 'POST /auth/login': ok(tokens()), 'GET /users/me': ok(customer), 'POST /auth/logout': 'NETWORK' })
    await offline.service.login({ email: 'a@b.co', password: 'x' })
    await offline.service.logout()
    expect(offline.service.hasStoredSession()).toBe(false)
  })

  it('rejects malformed token responses without storing anything', async () => {
    const { service } = setup({ 'POST /auth/login': ok({ accessToken: 'a', refreshToken: 'short' }) })
    await expect(service.login({ email: 'a@b.co', password: 'x' })).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
    expect(stored()).toBeNull()
  })
})

describe('password recovery', () => {
  it('requests a reset with the identifier only and accepts the generic answer', async () => {
    const { service, calls } = setup({ 'POST /auth/password/forgot': ok({ challengeSent: true }) })
    await expect(service.forgotPassword('a@b.co')).resolves.toBeUndefined()
    expect(calls[0].body).toEqual({ identifier: 'a@b.co' })
  })

  it('resets with identifier, code and new password, and starts no session', async () => {
    const { service, calls } = setup({ 'POST /auth/password/reset': ok({ reset: true }) })
    await service.resetPassword({ email: 'a@b.co', code: '654321', newPassword: 'N3wPassword' })
    expect(calls[0].body).toEqual({ identifier: 'a@b.co', code: '654321', newPassword: 'N3wPassword' })
    expect(service.hasStoredSession()).toBe(false)
  })
})
