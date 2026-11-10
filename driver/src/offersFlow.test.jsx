import { describe, expect, it } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import App from './App'
import { AuthProvider } from './auth/AuthContext'
import { createApiClient } from './api/apiClient'
import { createAuthService } from './auth/authService'
import { driverProfile, driverUser, fail, fakeFetch, ok, tokens } from './test/fakeBackend'

const inSeconds = (s) => new Date(Date.now() + s * 1000).toISOString()

const offer = (over = {}) => ({
  offerId: 'offer-1',
  round: 1,
  offeredAt: new Date().toISOString(),
  expiresAt: inSeconds(25),
  job: {
    jobId: 'job-1',
    orderId: 'order-1',
    fulfillmentId: 'f-1',
    status: 'OFFERED',
    pickupAddress: 'Seed Bole Pharmacy, Bole Main',
    dropoffAddress: 'Bole Road 12',
    isColdChain: false,
    isCod: true,
    codAmount: 5700,
    distanceMeters: 1033,
    pickedUpAt: null,
    deliveredAt: null,
    createdAt: new Date().toISOString(),
  },
  ...over,
})

async function signedInApp(routes) {
  const backend = fakeFetch({ 'POST /auth/login': ok(tokens()), 'GET /users/me': ok(driverUser), 'GET /driver/profile': ok(driverProfile()), ...routes })
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
  fireEvent.change(screen.getByLabelText('E-mail'), { target: { value: 'driver.walk@staging.pharmalink.test' } })
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'secret-pass' } })
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
  await screen.findByText('Offline')
  return backend
}

describe('availability and offers (Work 119)', () => {
  it('goes online, shows an offer with its time left and what it pays out in cash, and accepts it', async () => {
    const backend = await signedInApp({
      'PUT /driver/availability': ok(driverProfile({ availability: 'ONLINE', onShift: true })),
      'GET /driver/jobs': [ok({ items: [], offers: [offer()], total: 0, page: 1, size: 20 }), ok({ items: [{ ...offer().job, status: 'ASSIGNED' }], offers: [], total: 1, page: 1, size: 20 })],
      'POST /delivery/jobs/job-1/accept': ok({}),
    })

    fireEvent.click(screen.getByRole('button', { name: 'Go online' }))
    expect(await screen.findByText('Online')).toBeTruthy()
    expect(backend.callsTo('PUT /driver/availability')[0].body).toEqual({ status: 'ONLINE' })

    const card = await screen.findByRole('article', { name: 'Delivery offer' })
    expect(card.textContent).toMatch(/Bole Road 12/)
    expect(card.textContent).toMatch(/Collect cash: ETB 57.00/)
    expect(Number(screen.getByLabelText('Seconds left').textContent.replace('s', ''))).toBeGreaterThan(20)

    fireEvent.click(screen.getByRole('button', { name: 'Accept' }))
    await waitFor(() => expect(backend.callsTo('POST /delivery/jobs/job-1/accept')).toHaveLength(1))
    expect(await screen.findByText('assigned')).toBeTruthy()
  })

  it('declines an offer', async () => {
    const backend = await signedInApp({
      'PUT /driver/availability': ok(driverProfile({ availability: 'ONLINE', onShift: true })),
      'GET /driver/jobs': [ok({ items: [], offers: [offer()], total: 0, page: 1, size: 20 }), ok({ items: [], offers: [], total: 0, page: 1, size: 20 })],
      'POST /delivery/jobs/job-1/decline': ok({}),
    })
    fireEvent.click(screen.getByRole('button', { name: 'Go online' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Decline' }))
    await waitFor(() => expect(backend.callsTo('POST /delivery/jobs/job-1/decline')).toHaveLength(1))
    expect(await screen.findByText(/Waiting for a delivery offer/)).toBeTruthy()
  })

  it('says why an offer could not be accepted', async () => {
    await signedInApp({
      'PUT /driver/availability': ok(driverProfile({ availability: 'ONLINE', onShift: true })),
      'GET /driver/jobs': ok({ items: [], offers: [offer()], total: 0, page: 1, size: 20 }),
      'POST /delivery/jobs/job-1/accept': fail(409, 'OFFER_EXPIRED', 'Offer expired.'),
    })
    fireEvent.click(screen.getByRole('button', { name: 'Go online' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Accept' }))
    expect((await screen.findByRole('alert')).textContent).toBe('That offer has expired.')
  })

  it('an unverified driver is told why going online failed', async () => {
    await signedInApp({ 'PUT /driver/availability': fail(403, 'DRIVER_NOT_VERIFIED', 'Not verified.') })
    fireEvent.click(screen.getByRole('button', { name: 'Go online' }))
    expect((await screen.findByRole('alert')).textContent).toMatch(/not verified to drive/)
    expect(screen.getByText('Offline')).toBeTruthy()
  })
})
