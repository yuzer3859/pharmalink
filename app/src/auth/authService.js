import { ApiError } from './apiClient'
import { getDeviceInfo } from './device'

// Customer session manager. The backend stays the authority: this only holds the tokens it issues,
// asks it who the user is (`GET /users/me`) and forgets everything when it rejects the session.
//
// Storage: the access token lives in memory only. The refresh token is kept in sessionStorage so a
// reload in the same tab can restore the session; it is gone when the tab closes and is never shared
// with other tabs (so two tabs never race to rotate the same refresh token). Tokens are never put in
// URLs or logged. sessionStorage is still readable by script on this origin; an httpOnly cookie
// would need a backend change and is out of scope for this demo (see app/README.md).

const SESSION_KEY = 'pharmalink.customer.session'
const REFRESHABLE_CODES = new Set(['UNAUTHENTICATED', 'TOKEN_EXPIRED', 'AUTH_TOKEN_INVALID'])

const malformed = () => new ApiError(0, 'MALFORMED_RESPONSE', 'The server sent an unexpected response.')
const sessionExpired = () => new ApiError(401, 'SESSION_EXPIRED', 'Your session has ended. Please sign in again.')
const isRecord = (value) => typeof value === 'object' && value !== null

/**
 * Work 126 (live-walk deviation 2): an account the customer app does not serve. `accountKind` lets
 * the screen say where it belongs: staff to the operations portal, a driver to the driver app.
 */
const notCustomer = (accountKind) =>
  new ApiError(403, 'NOT_CUSTOMER', 'This account is not a customer account.', { accountKind })

function readTokens(data) {
  if (!isRecord(data) || typeof data.accessToken !== 'string' || !data.accessToken ||
      typeof data.refreshToken !== 'string' || data.refreshToken.length < 32) {
    // An administrator's sign-in answers with an authenticator challenge instead of tokens; that is a
    // staff account, not a broken response.
    if (isRecord(data) && (data.mfaRequired === true || typeof data.challengeToken === 'string')) throw notCustomer('STAFF')
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
  let restoring = null
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
      // Storage unavailable (private mode): the session still works until reload.
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
          // A network failure leaves the session for a later retry; any rejection by the server ends it.
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
    const send = () => {
      if (method === 'GET') return api.get(path, { accessToken })
      if (method === 'PATCH') return api.patch(path, body, { accessToken })
      if (method === 'DELETE') return api.delete(path, { accessToken })
      return api.post(path, body, { accessToken })
    }
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
        // The local session is cleared regardless; an unreachable server can't keep it alive.
      }
    }
    clearSession()
  }

  /** The signed-in user, from the server. Non-customer accounts are signed out here. */
  async function fetchCustomer() {
    const user = await authorized('GET', '/users/me')
    if (!isRecord(user) || typeof user.id !== 'string' || typeof user.primaryRole !== 'string') {
      throw malformed()
    }
    if (user.primaryRole !== 'CUSTOMER') {
      await logout()
      throw notCustomer(user.primaryRole === 'DRIVER' ? 'DRIVER' : 'STAFF')
    }
    return user
  }

  async function startSession(tokens) {
    setSession(readTokens(tokens))
    try {
      return await fetchCustomer()
    } catch (error) {
      if (error?.code !== 'NOT_CUSTOMER') clearSession()
      throw error
    }
  }

  return {
    hasStoredSession: () => refreshToken !== null,

    /** Work 100: a signed-in request (refreshes the session once on an expired access token). */
    request: (method, path, body) => authorized(method, path, body),

    /** Work 102: the current access token (refreshed first when absent), for the tracking socket's handshake. */
    async accessToken() {
      if (!accessToken) await refresh()
      return accessToken
    },

    onSessionExpired(listener) {
      expiredListeners.add(listener)
      return () => expiredListeners.delete(listener)
    },

    async register({ email, password, preferredLanguage }) {
      const data = await api.post('/auth/register', { email, password, preferredLanguage })
      if (!isRecord(data) || typeof data.userId !== 'string' || !isRecord(data.verification) ||
          typeof data.verification.target !== 'string') {
        throw malformed()
      }
      return data
    },

    async verifyRegistration({ email, code }) {
      const data = await api.post('/auth/verify-otp', {
        identifier: email,
        code,
        purpose: 'REGISTER',
        deviceInfo: deviceInfo(),
      })
      if (!isRecord(data) || data.verified !== true) throw malformed()
      // An administrator's code verifies the account but issues no session (Work 66).
      if (data.mfaRequired === true) throw notCustomer('STAFF')
      return startSession(data.tokens)
    },

    async resendRegistrationCode(email) {
      const data = await api.post('/auth/resend-otp', { identifier: email, purpose: 'REGISTER' })
      if (!isRecord(data) || data.resent !== true) throw malformed()
      return { cooldownSeconds: Number.isFinite(data.cooldownSeconds) ? data.cooldownSeconds : 0 }
    },

    async login({ email, password }) {
      const data = await api.post('/auth/login', { identifier: email, password, deviceInfo: deviceInfo() })
      return startSession(data)
    },

    async forgotPassword(email) {
      const data = await api.post('/auth/password/forgot', { identifier: email })
      if (!isRecord(data) || data.challengeSent !== true) throw malformed()
    },

    async resetPassword({ email, code, newPassword }) {
      const data = await api.post('/auth/password/reset', { identifier: email, code, newPassword })
      if (!isRecord(data) || data.reset !== true) throw malformed()
    },

    fetchCustomer,
    logout,

    /** Restores a stored session once per page load; null when there is none or it was rejected. */
    restore() {
      if (!restoring) {
        restoring = (async () => {
          if (!refreshToken) return null
          try {
            return await fetchCustomer()
          } catch (error) {
            if (error?.code === 'SESSION_EXPIRED' || error?.code === 'NOT_CUSTOMER') return null
            throw error
          }
        })()
      }
      return restoring
    },
  }
}
