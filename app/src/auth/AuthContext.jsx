import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { API_BASE_URL } from '../config/env'
import { createApiClient } from './apiClient'
import { createAuthService } from './authService'
import { t } from './strings'

// Status: 'initializing' while a stored session is being checked, then 'signedIn' or 'signedOut'.
// Components get the user and actions only; tokens stay inside the auth service.
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
    user: null,
    expired: false,
  }))

  useEffect(() => {
    let active = true
    if (service.hasStoredSession()) {
      service
        .restore()
        .then((user) => active && setState((s) => ({ status: user ? 'signedIn' : 'signedOut', user, expired: !user && s.expired })))
        .catch(() => active && setState({ status: 'signedOut', user: null, expired: false }))
    }
    const unsubscribe = service.onSessionExpired(() => {
      if (active) setState({ status: 'signedOut', user: null, expired: true })
    })
    return () => {
      active = false
      unsubscribe()
    }
  }, [service])

  const signedIn = useCallback((user) => {
    setState({ status: 'signedIn', user, expired: false })
    return user
  }, [])

  const value = useMemo(
    () => ({
      ...state,
      register: (input) => service.register(input),
      resendRegistrationCode: (email) => service.resendRegistrationCode(email),
      verifyRegistration: async (input) => signedIn(await service.verifyRegistration(input)),
      login: async (input) => signedIn(await service.login(input)),
      forgotPassword: (email) => service.forgotPassword(email),
      resetPassword: (input) => service.resetPassword(input),
      refreshUser: async () => signedIn(await service.fetchCustomer()),
      logout: async () => {
        await service.logout()
        setState({ status: 'signedOut', user: null, expired: false })
      },
    }),
    [service, state, signedIn],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

/**
 * Navigates once when mounted. React Router's <Navigate> navigates on every render, and a page that
 * is animating out (AnimatePresence mode="wait") keeps rendering, so <Navigate> there loops.
 */
function Redirect({ to, state }) {
  const navigate = useNavigate()
  const location = useLocation()
  const [done, setDone] = useState(false)
  useEffect(() => {
    if (done) return
    setDone(true)
    if (location.pathname !== to) navigate(to, { replace: true, state })
  }, [done, location.pathname, navigate, state, to])
  return null
}

export function useAuth() {
  const context = useContext(AuthContext)
  if (!context) throw new Error('useAuth must be used inside <AuthProvider>')
  return context
}

/** Renders its children for a signed-in customer; otherwise sends the visitor to sign in and back. */
export function RequireCustomer({ children }) {
  const { status } = useAuth()
  const location = useLocation()
  if (status === 'initializing') {
    return (
      <div role="status" aria-live="polite" className="py-24 text-center text-body text-muted">
        {t('nav.loadingSession')}…
      </div>
    )
  }
  if (status !== 'signedIn') {
    return <Redirect to="/login" state={{ from: location.pathname + location.search }} />
  }
  return children
}

/**
 * For sign-in/sign-up pages: once the customer is signed in (already, or by submitting the page),
 * they go to `to`. Pages never navigate on success themselves, so there is one redirect path.
 */
export function RedirectIfSignedIn({ to = '/account', children }) {
  const { status } = useAuth()
  if (status === 'signedIn') return <Redirect to={to} />
  return children
}

/** Only same-app paths are accepted as a post-login destination (no open redirects). */
export function safeDestination(from) {
  if (typeof from !== 'string' || !from.startsWith('/') || from.startsWith('//')) return '/account'
  if (['/login', '/register', '/verify-email', '/forgot-password', '/reset-password'].some((p) => from.startsWith(p))) {
    return '/account'
  }
  return from
}
