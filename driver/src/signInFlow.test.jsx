import { describe, expect, it } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import App from './App'
import { AuthProvider } from './auth/AuthContext'
import { createApiClient } from './api/apiClient'
import { createAuthService } from './auth/authService'
import { driverProfile, driverUser, fail, fakeFetch, ok, tokens } from './test/fakeBackend'
import { verificationText } from './pages/Home'

function renderApp(routes) {
  const backend = fakeFetch(routes)
  const auth = createAuthService({
    api: createApiClient({ baseUrl: 'http://api.test', fetcher: backend.fetcher }),
    deviceInfo: () => ({ fingerprint: 'fp-1', platform: 'WEB' }),
  })
  render(
    <MemoryRouter>
      <AuthProvider service={auth}>
        <App />
      </AuthProvider>
    </MemoryRouter>,
  )
  return backend
}

function signIn() {
  fireEvent.change(screen.getByLabelText('E-mail'), { target: { value: 'driver.walk@staging.pharmalink.test' } })
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'secret-pass' } })
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
}

describe('driver app sign-in (Work 118)', () => {
  it('signs a driver in and shows their status', async () => {
    renderApp({ 'POST /auth/login': ok(tokens()), 'GET /users/me': ok(driverUser), 'GET /driver/profile': ok(driverProfile()) })
    signIn()
    expect(await screen.findByText('Offline')).toBeTruthy()
    expect(screen.getByText('driver.walk@staging.pharmalink.test')).toBeTruthy()
  })

  it('tells an unverified driver why they cannot drive yet', async () => {
    renderApp({
      'POST /auth/login': ok(tokens()),
      'GET /users/me': ok(driverUser),
      'GET /driver/profile': ok(driverProfile({ verification: { isEligible: false, reason: 'DOCUMENTS_NOT_APPROVED', documentsExpireAt: null } })),
    })
    signIn()
    expect(await screen.findByText(/not approved your driving documents/)).toBeTruthy()
  })

  it('explains wrong credentials plainly', async () => {
    renderApp({ 'POST /auth/login': fail(401, 'AUTH_INVALID_CREDENTIALS', 'Invalid credentials.') })
    signIn()
    expect((await screen.findByRole('alert')).textContent).toMatch(/do not match a PharmaLink account/)
  })

  it('has a plain message for every verification reason, and none for a verified driver', () => {
    for (const reason of ['DOCUMENTS_NOT_APPROVED', 'DOCUMENTS_EXPIRED', 'ACCOUNT_NOT_ACTIVE', 'NOT_A_DRIVER', 'SOMETHING_NEW']) {
      expect(verificationText({ isEligible: false, reason })).toBeTruthy()
    }
    expect(verificationText({ isEligible: true, reason: null })).toBeNull()
  })
})
