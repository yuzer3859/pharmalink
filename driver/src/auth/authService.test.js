import { describe, expect, it } from 'vitest'
import { createApiClient } from '../api/apiClient'
import { createAuthService } from './authService'
import { REFRESH_A, driverProfile, driverUser, fail, fakeFetch, ok, tokens } from '../test/fakeBackend'

const device = () => ({ fingerprint: 'fp-test-1', platform: 'WEB', name: 'test' })

function service(routes, storage = sessionStorage) {
  const backend = fakeFetch(routes)
  const api = createApiClient({ baseUrl: 'http://api.test', fetcher: backend.fetcher })
  return { auth: createAuthService({ api, storage, deviceInfo: device }), backend }
}

describe('driver auth service (Work 118)', () => {
  it('signs a driver in by e-mail, reads who they are and their driver profile, and keeps only the refresh token', async () => {
    const { auth, backend } = service({
      'POST /auth/login': ok(tokens()),
      'GET /users/me': ok(driverUser),
      'GET /driver/profile': ok(driverProfile()),
    })
    const driver = await auth.login({ email: ' driver.walk@staging.pharmalink.test ', password: 'secret-pass' })

    expect(driver.user.id).toBe('d-1')
    expect(driver.profile.availability).toBe('OFFLINE')
    expect(backend.callsTo('POST /auth/login')[0].body).toEqual({
      identifier: 'driver.walk@staging.pharmalink.test',
      password: 'secret-pass',
      deviceInfo: device(),
    })
    expect(backend.callsTo('GET /driver/profile')[0].headers.Authorization).toBe('Bearer access-1')
    expect(JSON.parse(sessionStorage.getItem('pharmalink.driver.session'))).toEqual({ refreshToken: REFRESH_A })
  })

  it('refuses a customer account with a clear reason and signs it out', async () => {
    const { auth } = service({
      'POST /auth/login': ok(tokens()),
      'GET /users/me': ok({ ...driverUser, primaryRole: 'CUSTOMER', roles: [{ roleKey: 'CUSTOMER', organizationId: null }] }),
      'POST /auth/logout': ok(null),
    })
    await expect(auth.login({ email: 'c@example.com', password: 'x' })).rejects.toMatchObject({ code: 'NOT_DRIVER' })
    expect(auth.hasStoredSession()).toBe(false)
  })

  it('refuses a driver account that has no driver profile yet', async () => {
    const { auth } = service({
      'POST /auth/login': ok(tokens()),
      'GET /users/me': ok(driverUser),
      'GET /driver/profile': fail(404, 'NOT_FOUND', 'Driver operational profile not found.'),
      'POST /auth/logout': ok(null),
    })
    await expect(auth.login({ email: 'd@example.com', password: 'x' })).rejects.toMatchObject({ code: 'NOT_DRIVER' })
  })

  it('says a staff account belongs in the operations portal instead of a generic error', async () => {
    const { auth } = service({ 'POST /auth/login': ok({ mfaRequired: true, challengeToken: 'c'.repeat(40) }) })
    await expect(auth.login({ email: 'admin@example.com', password: 'x' })).rejects.toMatchObject({ code: 'STAFF_ACCOUNT' })
    expect(auth.hasStoredSession()).toBe(false)
  })

  it('refreshes once on an expired access token and retries', async () => {
    const { auth, backend } = service({
      'POST /auth/login': ok(tokens()),
      'GET /users/me': ok(driverUser),
      'GET /driver/profile': [ok(driverProfile()), fail(401, 'TOKEN_EXPIRED'), ok(driverProfile({ availability: 'ONLINE' }))],
      'POST /auth/token/refresh': ok(tokens('access-2', 's'.repeat(40))),
    })
    await auth.login({ email: 'd@example.com', password: 'x' })
    const profile = await auth.request('GET', '/driver/profile')
    expect(profile.availability).toBe('ONLINE')
    expect(backend.callsTo('POST /auth/token/refresh')).toHaveLength(1)
  })

  it('restores a stored session on reload, and none when the server rejects it', async () => {
    sessionStorage.setItem('pharmalink.driver.session', JSON.stringify({ refreshToken: REFRESH_A }))
    const restored = service({
      'POST /auth/token/refresh': ok(tokens('access-3', 't'.repeat(40))),
      'GET /users/me': ok(driverUser),
      'GET /driver/profile': ok(driverProfile()),
    })
    expect((await restored.auth.restore()).user.id).toBe('d-1')

    sessionStorage.setItem('pharmalink.driver.session', JSON.stringify({ refreshToken: REFRESH_A }))
    const rejected = service({ 'POST /auth/token/refresh': fail(401, 'AUTH_TOKEN_INVALID') })
    expect(await rejected.auth.restore()).toBeNull()
  })
})
