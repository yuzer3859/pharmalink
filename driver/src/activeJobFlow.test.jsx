import { describe, expect, it } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import App from './App'
import { AuthProvider } from './auth/AuthContext'
import { createApiClient } from './api/apiClient'
import { createAuthService } from './auth/authService'
import { driverProfile, driverUser, fail, fakeFetch, ok, tokens } from './test/fakeBackend'

const job = (status, over = {}) => ({
  jobId: 'job-1',
  orderId: 'order-1',
  fulfillmentId: 'f-1',
  status,
  pickupAddress: 'Seed Bole Pharmacy, Bole Main',
  dropoffAddress: 'Bole Road 12',
  isColdChain: false,
  isCod: true,
  codAmount: 5700,
  distanceMeters: 1033,
  pickedUpAt: null,
  deliveredAt: null,
  createdAt: new Date().toISOString(),
  ...over,
})
const page = (...items) => ok({ items, offers: [], total: items.length, page: 1, size: 20 })

async function openJob(routes) {
  const backend = fakeFetch({
    'POST /auth/login': ok(tokens()),
    'GET /users/me': ok(driverUser),
    'GET /driver/profile': ok(driverProfile({ availability: 'ONLINE', onShift: true })),
    ...routes,
  })
  const auth = createAuthService({
    api: createApiClient({ baseUrl: 'http://api.test', fetcher: backend.fetcher }),
    deviceInfo: () => ({ fingerprint: 'fp-1', platform: 'WEB' }),
  })
  render(
    <MemoryRouter initialEntries={['/jobs/job-1']}>
      <AuthProvider service={auth}>
        <App />
      </AuthProvider>
    </MemoryRouter>,
  )
  fireEvent.change(screen.getByLabelText('E-mail'), { target: { value: 'driver.walk@staging.pharmalink.test' } })
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'secret-pass' } })
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
  return backend
}

describe('the active job (Work 120)', () => {
  it('heads to the pharmacy, then moves one step at a time to the customer', async () => {
    const backend = await openJob({
      'GET /driver/jobs': [page(job('ASSIGNED')), page(job('ARRIVED_PICKUP')), page(job('PICKED_UP'))],
      'POST /delivery/jobs/job-1/arrived-pickup': ok({}),
      'POST /delivery/jobs/job-1/picked-up': ok({}),
    })
    expect(await screen.findByText('Go to the pharmacy')).toBeTruthy()
    expect(screen.getByRole('region', { name: 'Destination' }).textContent).toMatch(/Seed Bole Pharmacy/)
    expect(screen.getByText(/Collect ETB 57.00 in cash/)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'I am at the pharmacy' }))
    expect(await screen.findByText('At the pharmacy')).toBeTruthy()
    expect(backend.callsTo('POST /delivery/jobs/job-1/arrived-pickup')).toHaveLength(1)

    fireEvent.click(screen.getByRole('button', { name: 'I have picked up the order' }))
    expect(await screen.findByText('Order picked up')).toBeTruthy()
    expect(screen.getByRole('region', { name: 'Destination' }).textContent).toMatch(/Bole Road 12/)
  })

  it('at the customer, the next thing is proof of delivery', async () => {
    await openJob({ 'GET /driver/jobs': page(job('ARRIVED_DROPOFF')) })
    expect(await screen.findByRole('link', { name: 'Record proof of delivery' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /I have arrived/ })).toBeNull()
  })

  it('reports a failed delivery with a reason, only once the order is picked up', async () => {
    const backend = await openJob({
      'GET /driver/jobs': [page(job('EN_ROUTE')), page(job('FAILED'))],
      'POST /delivery/jobs/job-1/fail': ok({}),
    })
    fireEvent.click(await screen.findByRole('button', { name: 'I cannot deliver this' }))
    fireEvent.change(screen.getByLabelText(/What went wrong/), { target: { value: 'Customer not reachable' } })
    fireEvent.click(screen.getByRole('button', { name: 'Report failed' }))
    await waitFor(() => expect(backend.callsTo('POST /delivery/jobs/job-1/fail')[0]?.body).toEqual({ reason: 'Customer not reachable' }))
    expect(await screen.findByText('Delivery failed')).toBeTruthy()
  })

  it('explains a step the backend refused', async () => {
    await openJob({
      'GET /driver/jobs': page(job('ASSIGNED')),
      'POST /delivery/jobs/job-1/arrived-pickup': fail(409, 'INVALID_STATE_TRANSITION', 'Not allowed.'),
    })
    fireEvent.click(await screen.findByRole('button', { name: 'I am at the pharmacy' }))
    expect((await screen.findByRole('alert')).textContent).toMatch(/changed meanwhile/)
  })
})
