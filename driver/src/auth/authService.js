import { ApiError, isRecord } from '../api/apiClient'
import { getDeviceInfo } from './device'

// Driver session manager (Work 118). The backend stays the authority: this holds the tokens it
// issues, asks who the user is (`GET /users/me`) and which driver they are (`GET /driver/profile`),
// and forgets everything when it rejects the session.
//
// Storage, as in the customer app: the access token in memory only; the refresh token in
// sessionStorage so a reload in the same tab restores the session. Tokens never go in URLs or logs.

const SESSION_KEY = 'pharmalink.driver.session'
const REFRESHABLE_CODES = new Set(['UNAUTHENTICATED', 'TOKEN_EXPIRED', 'AUTH_TOKEN_INVALID'])

const malformed = () => new ApiError(0, 'MALFORMED_RESPONSE', 'PharmaLink sent an unexpected response.')
const sessionExpired = () => new ApiError(401, 'SESSION_EXPIRED', 'Your session has ended. Please sign in again.')
export const notDriver = () => new ApiError(403, 'NOT_DRIVER', 'This is not a driver account. Sign in with the account PharmaLink gave you for driving.')
const staffAccount = () => new ApiError(403, 'STAFF_ACCOUNT', 'This is a PharmaLink staff account. Use the operations portal; the driver app is for drivers only.')

function readTokens(data) {
  if (!isRecord(data) || typeof data.accessToken !== 'string' || !data.accessToken ||
      typeof data.refreshToken !== 'string' || data.refreshToken.length < 32) {
    // A sign-in that asks for an authenticator code is an administrator's, never a driver's.
    if (isRecord(data) && (data.mfaRequired === true || typeof data.challengeToken === 'string')) throw staffAccount()
    throw malformed()
  }
  return { accessToken: data.accessToken, refreshToken: data.refreshToken }
}

function safeSessionStorage() {
  try {
    return globalThis.sessionStorage ?? null
  } catch {
    return null
  }
}

export function createAuthService({ api, storage = safeSessionStorage(), deviceInfo = getDeviceInfo }) {
  let accessToken = null
  let refreshToken = null
  let refreshing = null
  const expiredListeners = new Set()

  try {
    const stored = storage?.getItem(SESSION_KEY)
    if (stored) refreshToken = JSON.parse(stored)?.refreshToken ?? null
  } catch {
    refreshToken = null
  }

  function setSession(tokens) {
    accessToken = tokens.accessToken
    refreshToken = tokens.refreshToken
    try {
      storage?.setItem(SESSION_KEY, JSON.stringify({ refreshToken }))
    } catch {
      // Storage unavailable: the session still works until reload.
    }
  }

  function clearSession() {
    accessToken = null
    refreshToken = null
    try {
      storage?.removeItem(SESSION_KEY)
    } catch {
      // nothing to clear
    }
  }

  function expire() {
    clearSession()
    expiredListeners.forEach((listener) => listener())
  }

  /** One refresh at a time: refresh tokens rotate and a reused one revokes the whole family. */
  function refresh() {
    if (!refreshToken) return Promise.reject(sessionExpired())
    if (!refreshing) {
      const presented = refreshToken
      refreshing = api
        .post('/auth/token/refresh', { refreshToken: presented })
        .then((data) => {
          setSession(readTokens(data))
          return accessToken
        })
        .catch((error) => {
          if (error instanceof ApiError && error.status !== 0) {
            expire()
            throw sessionExpired()
          }
          throw error
        })
        .finally(() => {
          refreshing = null
        })
    }
    return refreshing
  }

  async function authorized(method, path, body) {
    if (!accessToken) await refresh()
    const send = () => api.request(path, { method, body, accessToken })
    try {
      return await send()
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 401 || !REFRESHABLE_CODES.has(error.code)) throw error
    }
    await refresh()
    try {
      return await send()
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        expire()
        throw sessionExpired()
      }
      throw error
    }
  }

  async function logout() {
    if (refreshToken) {
      try {
        await authorized('POST', '/auth/logout', { refreshToken })
      } catch {
        // The local session is cleared regardless.
      }
    }
    clearSession()
  }

  /**
   * The signed-in driver: their account and their driver profile. An account without the DRIVER
   * role, or without a driver profile, is signed out with a clear reason.
   */
  async function fetchDriver() {
    const user = await authorized('GET', '/users/me')
    if (!isRecord(user) || typeof user.id !== 'string') throw malformed()
    const roles = Array.isArray(user.roles) ? user.roles.map((r) => r?.roleKey) : []
    if (user.primaryRole !== 'DRIVER' && !roles.includes('DRIVER')) {
      await logout()
      throw notDriver()
    }
    let profile
    try {
      profile = await authorized('GET', '/driver/profile')
    } catch (error) {
      if (error instanceof ApiError && (error.status === 404 || error.status === 403)) {
        await logout()
        throw notDriver()
      }
      throw error
    }
    return { user, profile }
  }

  async function startSession(tokens) {
    setSession(readTokens(tokens))
    try {
      return await fetchDriver()
    } catch (error) {
      if (error?.code !== 'NOT_DRIVER') clearSession()
      throw error
    }
  }

  return {
    hasStoredSession: () => refreshToken !== null,
    request: (method, path, body) => authorized(method, path, body),
    async accessToken() {
      if (!accessToken) await refresh()
      return accessToken
    },
    onSessionExpired(listener) {
      expiredListeners.add(listener)
      return () => expiredListeners.delete(listener)
    },
    async login({ email, password }) {
      let data
      try {
        data = await api.post('/auth/login', { identifier: email.trim(), password, deviceInfo: deviceInfo() })
      } catch (error) {
        if (error instanceof ApiError && (error.code === 'MFA_REQUIRED' || error.code === 'AUTH_MFA_REQUIRED')) throw staffAccount()
        throw error
      }
      return startSession(data)
    },
    fetchDriver,
    logout,
    /** Restores a stored session once per page load; null when there is none or it was rejected. */
    async restore() {
      if (!refreshToken) return null
      try {
        return await fetchDriver()
      } catch (error) {
        if (error?.code === 'SESSION_EXPIRED' || error?.code === 'NOT_DRIVER') return null
        throw error
      }
    },
  }
}
