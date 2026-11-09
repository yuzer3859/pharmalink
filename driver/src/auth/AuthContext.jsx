import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { API_BASE_URL } from '../config/env'
import { createApiClient } from '../api/apiClient'
import { createAuthService } from './authService'

// Status: 'initializing' while a stored session is checked, then 'signedIn' or 'signedOut'.
// Components get the driver and actions only; tokens stay inside the auth service.
const AuthContext = createContext(null)

let defaultService
function getDefaultService() {
  if (!defaultService) defaultService = createAuthService({ api: createApiClient({ baseUrl: API_BASE_URL }) })
  return defaultService
}

export function AuthProvider({ service: provided, children }) {
  const service = provided ?? getDefaultService()
  const [state, setState] = useState(() => ({
    status: service.hasStoredSession() ? 'initializing' : 'signedOut',
    driver: null,
    expired: false,
  }))

  useEffect(() => {
    let active = true
    if (service.hasStoredSession()) {
      service
        .restore()
        .then((driver) => active && setState((s) => ({ status: driver ? 'signedIn' : 'signedOut', driver, expired: !driver && s.expired })))
        .catch(() => active && setState({ status: 'signedOut', driver: null, expired: false }))
    }
    const unsubscribe = service.onSessionExpired(() => {
      if (active) setState({ status: 'signedOut', driver: null, expired: true })
    })
    return () => {
      active = false
      unsubscribe()
    }
  }, [service])

  const signedIn = useCallback((driver) => {
    setState({ status: 'signedIn', driver, expired: false })
    return driver
  }, [])

  const value = useMemo(
    () => ({
      ...state,
      login: async (input) => signedIn(await service.login(input)),
      refreshDriver: async () => signedIn(await service.fetchDriver()),
      /** Replace the profile after a call that returned a fresh one (availability). */
      setProfile: (profile) => setState((s) => (s.driver ? { ...s, driver: { ...s.driver, profile } } : s)),
      request: (method, path, body) => service.request(method, path, body),
      accessToken: () => service.accessToken(),
      logout: async () => {
        await service.logout()
        setState({ status: 'signedOut', driver: null, expired: false })
      },
    }),
    [state, service, signedIn],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const value = useContext(AuthContext)
  if (!value) throw new Error('useAuth must be used inside AuthProvider')
  return value
}
