import { beforeAll, describe, expect, it } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { MotionGlobalConfig } from 'framer-motion'
import App from '../App'
import { AuthProvider } from './AuthContext'
import { createApiClient } from './apiClient'
import { createAuthService } from './authService'
import { REFRESH_A, customer, fail, fakeFetch, ok, tokens } from '../test/fakeBackend'

beforeAll(() => {
  MotionGlobalConfig.skipAnimations = true
})

const device = () => ({ fingerprint: 'device-1', platform: 'WEB' })

function renderApp(path, routes, { state } = {}) {
  const backend = fakeFetch(routes)
  const service = createAuthService({
    api: createApiClient({ baseUrl: 'http://api.test', fetcher: backend.fetcher }),
    storage: sessionStorage,
    deviceInfo: device,
  })
  render(
    <MemoryRouter initialEntries={[{ pathname: path, state }]}>
      <AuthProvider service={service}>
        <App />
      </AuthProvider>
    </MemoryRouter>,
  )
  return backend
}

const type = (label, value) => fireEvent.change(screen.getByLabelText(label), { target: { value } })
const submit = (name) => fireEvent.click(screen.getByRole('button', { name }))
const header = () => screen.getByRole('banner')

describe('registration', () => {
  it('validates fields before calling the backend', async () => {
    const { calls } = renderApp('/register', {})
    submit('Create account')
    expect(await screen.findByText('Enter your e-mail address.')).toBeTruthy()
    expect(screen.getByText('Enter a password.')).toBeTruthy()

    type('E-mail address', 'not-an-email')
    type('Password', 'weakpass')
    type('Confirm password', 'different')
    submit('Create account')
    expect(await screen.findByText(/valid e-mail address/)).toBeTruthy()
    expect(screen.getByText(/does not meet all the requirements/)).toBeTruthy()
    expect(screen.getByText('The passwords do not match.')).toBeTruthy()
    expect(screen.getByLabelText('E-mail address').getAttribute('aria-invalid')).toBe('true')
    expect(calls).toHaveLength(0)
  })

  it('does not ask for a phone number', () => {
    renderApp('/register', {})
    expect(screen.queryByLabelText(/phone/i)).toBeNull()
    expect(screen.getByText(/phone number is not needed/)).toBeTruthy()
  })

  it('registers and moves to e-mail verification with the masked address', async () => {
    const { calls } = renderApp('/register', {
      'POST /auth/register': ok({ userId: 'u-1', status: 'PENDING_VERIFICATION', verification: { channel: 'EMAIL', target: 'm***@example.com' } }, 201),
    })
    type('E-mail address', ' meron@example.com ')
    type('Password', 'Passw0rdX')
    type('Confirm password', 'Passw0rdX')
    fireEvent.change(screen.getByLabelText('Preferred language'), { target: { value: 'am' } })
    submit('Create account')
    expect(await screen.findByText('We sent a six-digit code to m***@example.com.')).toBeTruthy()
    expect(calls[0].body).toEqual({ email: 'meron@example.com', password: 'Passw0rdX', preferredLanguage: 'am' })
  })

  it('shows the backend delivery error and stays on the page', async () => {
    renderApp('/register', {
      'POST /auth/register': fail(503, 'DEPENDENCY_UNAVAILABLE', 'x', { channel: 'EMAIL', reason: 'NOT_CONFIGURED' }),
    })
    type('E-mail address', 'meron@example.com')
    type('Password', 'Passw0rdX')
    type('Confirm password', 'Passw0rdX')
    submit('Create account')
    expect((await screen.findByRole('alert')).textContent).toMatch(/not set up on this PharmaLink server, so no code was sent/)
    expect(screen.getByRole('heading', { name: 'Create your PharmaLink account' })).toBeTruthy()
  })
})

describe('e-mail verification', () => {
  const state = { email: 'meron@example.com', target: 'm***@example.com' }

  it('accepts digits only, rejects a short code and shows invalid/expired messages', async () => {
    const { calls } = renderApp('/verify-email', {
      'POST /auth/verify-otp': [fail(400, 'AUTH_OTP_INVALID'), fail(410, 'AUTH_OTP_EXPIRED')],
    }, { state })
    const input = screen.getByLabelText('Six-digit code')
    expect(input.getAttribute('inputmode')).toBe('numeric')
    expect(input.getAttribute('autocomplete')).toBe('one-time-code')
    fireEvent.change(input, { target: { value: '12a3' } })
    expect(input.value).toBe('123')
    submit('Verify e-mail')
    expect(await screen.findByText('Enter the six-digit code from the e-mail.')).toBeTruthy()
    expect(calls).toHaveLength(0)

    fireEvent.paste(input, { clipboardData: { getData: () => '123 456' } })
    expect(input.value).toBe('123456')
    submit('Verify e-mail')
    expect((await screen.findByRole('alert')).textContent).toMatch(/not correct/)

    fireEvent.change(input, { target: { value: '654321' } })
    submit('Verify e-mail')
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/expired/))
  })

  it('verifies, signs the customer in and shows e-mail verified separately from Fayda', async () => {
    renderApp('/verify-email', {
      'POST /auth/verify-otp': ok({ verified: true, tokens: tokens() }),
      'GET /users/me': ok(customer),
    }, { state })
    type('Six-digit code', '123456')
    submit('Verify e-mail')
    expect(await screen.findByRole('heading', { name: 'My account' })).toBeTruthy()
    expect(screen.getByText(/E-mail verified on/)).toBeTruthy()
    expect(screen.getByText('Fayda identity verification is not yet connected.')).toBeTruthy()
    expect(document.body.textContent).not.toMatch(/Fayda ID verified/i)
    expect(screen.getByText('meron@example.com', { selector: 'dd' })).toBeTruthy()
  })

  it('starts the countdown the backend sets after a resend and disables the button', async () => {
    renderApp('/verify-email', { 'POST /auth/resend-otp': ok({ resent: true, cooldownSeconds: 30 }) }, { state })
    submit('Send a new code')
    expect(await screen.findByText(/We e-mailed you a new code/)).toBeTruthy()
    const button = screen.getByRole('button', { name: /request a new code in 30 s/ })
    expect(button.disabled).toBe(true)
  })

  it('uses retryAfterSeconds from a cooldown error', async () => {
    renderApp('/verify-email', { 'POST /auth/resend-otp': fail(429, 'RATE_LIMITED', 'wait', { retryAfterSeconds: 12 }) }, { state })
    submit('Send a new code')
    expect((await screen.findByRole('alert')).textContent).toBe('Try again in 12 s.')
    expect(screen.getByRole('button', { name: /request a new code in 12 s/ }).disabled).toBe(true)
  })

  it('asks for the e-mail address when opened directly', async () => {
    const { calls } = renderApp('/verify-email', { 'POST /auth/resend-otp': ok({ resent: true, cooldownSeconds: 30 }) })
    expect(screen.getByText('Enter the six-digit code we e-mailed you.')).toBeTruthy()
    submit('Send a new code')
    expect(await screen.findByText('Enter your e-mail address.')).toBeTruthy()
    expect(calls).toHaveLength(0)
  })
})

describe('login and the account route', () => {
  it('sends a signed-out visitor from /account to sign in, then back after login', async () => {
    const { calls } = renderApp('/account', { 'POST /auth/login': ok(tokens()), 'GET /users/me': ok(customer) })
    expect(await screen.findByRole('heading', { name: 'Sign in to PharmaLink' })).toBeTruthy()
    submit('Sign in')
    expect(await screen.findByText('Enter your e-mail address.')).toBeTruthy()
    expect(calls).toHaveLength(0)

    type('E-mail address', 'meron@example.com')
    type('Password', 'Passw0rdX')
    submit('Sign in')
    expect(await screen.findByRole('heading', { name: 'My account' })).toBeTruthy()
    expect(calls[0].body).toMatchObject({ identifier: 'meron@example.com', deviceInfo: { platform: 'WEB' } })
  })

  it('shows a generic invalid-credentials error with a verification hint', async () => {
    renderApp('/login', { 'POST /auth/login': fail(401, 'AUTH_INVALID_CREDENTIALS') })
    type('E-mail address', 'meron@example.com')
    type('Password', 'wrong')
    submit('Sign in')
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toMatch(/incorrect, or the account is not active yet/)
    expect(within(alert).getByRole('link', { name: /Verify your e-mail first/ })).toBeTruthy()
    expect(screen.getByLabelText('Password').value).toBe('')
  })

  it('refuses a staff account', async () => {
    renderApp('/login', {
      'POST /auth/login': ok(tokens()),
      'GET /users/me': ok({ ...customer, primaryRole: 'SUPER_ADMIN' }),
      'POST /auth/logout': { status: 204 },
    })
    type('E-mail address', 'admin@example.com')
    type('Password', 'Passw0rdX')
    submit('Sign in')
    expect((await screen.findByRole('alert')).textContent).toMatch(/staff account/)
    expect(within(header()).getByRole('link', { name: /Sign in/ })).toBeTruthy()
  })

  it('reports a network failure', async () => {
    renderApp('/login', { 'POST /auth/login': 'NETWORK' })
    type('E-mail address', 'meron@example.com')
    type('Password', 'x')
    submit('Sign in')
    expect((await screen.findByRole('alert')).textContent).toMatch(/could not reach PharmaLink/)
  })
})

describe('navigation, logout and session expiry', () => {
  it('shows sign-in actions when signed out and the customer menu when signed in', async () => {
    sessionStorage.setItem('pharmalink.customer.session', JSON.stringify({ refreshToken: REFRESH_A }))
    renderApp('/', {
      'POST /auth/token/refresh': ok(tokens('access-2', 'q'.repeat(40))),
      'GET /users/me': ok(customer),
      'POST /auth/logout': { status: 204 },
    })
    // While the stored session is checked, neither state is shown.
    expect(within(header()).queryByRole('link', { name: /Sign in/ })).toBeNull()
    const menuButton = await within(header()).findByRole('button', { name: 'Account menu' })
    expect(document.body.textContent).not.toContain('Meron A')
    fireEvent.click(menuButton)
    const menu = screen.getByRole('menu')
    expect(within(menu).getByText('meron@example.com')).toBeTruthy()
    expect(within(menu).getByRole('menuitem', { name: /My account/ })).toBeTruthy()

    await act(async () => fireEvent.click(within(menu).getByRole('menuitem', { name: /Sign out/ })))
    expect(await within(header()).findByRole('link', { name: /Sign in/ })).toBeTruthy()
    expect(within(header()).getByRole('link', { name: /Create account/ })).toBeTruthy()
    expect(sessionStorage.getItem('pharmalink.customer.session')).toBeNull()
  })

  it('signs out from the account page', async () => {
    sessionStorage.setItem('pharmalink.customer.session', JSON.stringify({ refreshToken: REFRESH_A }))
    const { callsTo } = renderApp('/account', {
      'POST /auth/token/refresh': ok(tokens('access-2', 'q'.repeat(40))),
      'GET /users/me': ok(customer),
      'POST /auth/logout': { status: 204 },
    })
    await screen.findByRole('heading', { name: 'My account' })
    await act(async () => fireEvent.click(screen.getByRole('button', { name: /^Sign out$/ })))
    expect(await screen.findByRole('heading', { name: 'Sign in to PharmaLink' })).toBeTruthy()
    expect(callsTo('POST /auth/logout')).toHaveLength(1)
  })

  it('returns to sign in with a notice when the stored session is rejected', async () => {
    sessionStorage.setItem('pharmalink.customer.session', JSON.stringify({ refreshToken: REFRESH_A }))
    renderApp('/account', { 'POST /auth/token/refresh': fail(401, 'AUTH_REFRESH_INVALID') })
    expect(await screen.findByRole('heading', { name: 'Sign in to PharmaLink' })).toBeTruthy()
    expect(screen.getByText('Your session ended. Please sign in again.')).toBeTruthy()
  })

  it('shows e-mail unverified and Fayda not connected without inventing data', async () => {
    sessionStorage.setItem('pharmalink.customer.session', JSON.stringify({ refreshToken: REFRESH_A }))
    renderApp('/account', {
      'POST /auth/token/refresh': ok(tokens('access-2', 'q'.repeat(40))),
      'GET /users/me': ok({ ...customer, emailVerifiedAt: null, status: 'PENDING_VERIFICATION', faydaVerified: false }),
    })
    expect(await screen.findByText('E-mail not verified')).toBeTruthy()
    expect(screen.getByText('Waiting for e-mail verification')).toBeTruthy()
    expect(screen.getByText('Fayda identity verification is not yet connected.')).toBeTruthy()
  })
})

describe('password recovery', () => {
  it('shows one generic message whether or not the address has an account', async () => {
    const texts = []
    for (const email of ['known@example.com', 'unknown@example.com']) {
      const { calls } = renderApp('/forgot-password', { 'POST /auth/password/forgot': ok({ challengeSent: true }) })
      type('E-mail address', email)
      submit('Send reset code')
      texts.push((await screen.findByRole('status')).textContent)
      expect(calls[0].body).toEqual({ identifier: email })
      document.body.innerHTML = ''
    }
    expect(texts[0]).toBe(texts[1])
    expect(texts[0]).toMatch(/If an account can be reset with that address/)
  })

  it('validates the reset form, then resets and offers sign-in without claiming a session', async () => {
    const { calls } = renderApp('/reset-password', { 'POST /auth/password/reset': ok({ reset: true }) }, { state: { email: 'meron@example.com' } })
    expect(screen.getByLabelText('E-mail address').value).toBe('meron@example.com')
    submit('Reset password')
    expect(await screen.findByText('Enter the six-digit code from the e-mail.')).toBeTruthy()
    expect(calls).toHaveLength(0)

    type('Six-digit code', '654321')
    type('New password', 'N3wPassword')
    type('Confirm new password', 'N3wPassword')
    submit('Reset password')
    expect(await screen.findByText('Your password was reset. Sign in with your new password.')).toBeTruthy()
    expect(calls[0].body).toEqual({ identifier: 'meron@example.com', code: '654321', newPassword: 'N3wPassword' })
    expect(sessionStorage.getItem('pharmalink.customer.session')).toBeNull()
  })

  it('shows the backend password-policy requirements and an expired code', async () => {
    renderApp('/reset-password', {
      'POST /auth/password/reset': [
        fail(400, 'AUTH_WEAK_PASSWORD', 'weak', { field: 'password', requirements: ['Must contain a digit.'] }),
        fail(410, 'AUTH_OTP_EXPIRED'),
      ],
    }, { state: { email: 'meron@example.com' } })
    type('Six-digit code', '654321')
    type('New password', 'N3wPassword')
    type('Confirm new password', 'N3wPassword')
    submit('Reset password')
    expect((await screen.findByRole('alert')).textContent).toMatch(/Must contain a digit/)
    type('Six-digit code', '654321')
    submit('Reset password')
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/expired/))
  })
})
