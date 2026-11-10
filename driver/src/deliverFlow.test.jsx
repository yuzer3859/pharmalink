import { describe, expect, it } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import App from './App'
import { AuthProvider } from './auth/AuthContext'
import { createApiClient } from './api/apiClient'
import { createAuthService } from './auth/authService'
import { driverProfile, driverUser, fail, fakeFetch, ok, tokens } from './test/fakeBackend'

const NONE = { podRequirement: 'NONE', codCollectionRequired: false, codExactAmountRequired: false }

const job = (over = {}) => ({
  jobId: 'job-1',
  orderId: 'order-1',
  fulfillmentId: 'f-1',
  status: 'ARRIVED_DROPOFF',
  pickupAddress: 'Seed Bole Pharmacy, Bole Main',
  dropoffAddress: 'Bole Road 12',
  isColdChain: false,
  isCod: true,
  codAmount: 5700,
  distanceMeters: 1033,
  pickedUpAt: new Date().toISOString(),
  deliveredAt: null,
  createdAt: new Date().toISOString(),
  rules: NONE,
  ...over,
})
const page = (...items) => ok({ items, offers: [], total: items.length, page: 1, size: 20 })

async function atTheDoor(routes) {
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
    <MemoryRouter initialEntries={['/jobs/job-1/deliver']}>
      <AuthProvider service={auth}>
        <App />
      </AuthProvider>
    </MemoryRouter>,
  )
  fireEvent.change(screen.getByLabelText('E-mail'), { target: { value: 'driver.walk@staging.pharmalink.test' } })
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'secret-pass' } })
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
  await screen.findByText('Hand over the order')
  return backend
}

describe('handing over the order (Work 122)', () => {
  it('records the cash due, the customer’s confirmation, then delivers', async () => {
    const backend = await atTheDoor({
      'GET /driver/jobs': page(job()),
      'POST /delivery/jobs/job-1/cod-collection': ok({}),
      'POST /delivery/jobs/job-1/proof-of-delivery': ok({}),
      'POST /delivery/jobs/job-1/deliver': ok({}),
    })
    expect(screen.getByRole('region', { name: 'Cash on delivery' }).textContent).toMatch(/Collect ETB 57.00/)
    fireEvent.change(screen.getByLabelText('Received by (name)'), { target: { value: 'Selam' } })
    fireEvent.click(screen.getByLabelText(/confirms they received/))
    fireEvent.click(screen.getByRole('button', { name: 'Complete delivery' }))

    await waitFor(() => expect(backend.callsTo('POST /delivery/jobs/job-1/deliver')).toHaveLength(1))
    expect(backend.callsTo('POST /delivery/jobs/job-1/cod-collection')[0].body).toEqual({ collectedAmount: 5700, method: 'CASH' })
    expect(backend.callsTo('POST /delivery/jobs/job-1/proof-of-delivery')[0].body).toEqual({ type: 'CONFIRMATION', recipientName: 'Selam', recipientConfirmed: true })
    expect(await screen.findByText('Delivered. Thank you!')).toBeTruthy()
  })

  it('a retry after a lost answer does not record anything twice', async () => {
    const backend = await atTheDoor({
      'GET /driver/jobs': page(job()),
      'POST /delivery/jobs/job-1/cod-collection': fail(409, 'CONFLICT', 'This delivery already has a recorded COD collection, which cannot be replaced.'),
      'POST /delivery/jobs/job-1/proof-of-delivery': ok({}),
      'POST /delivery/jobs/job-1/deliver': ok({}),
    })
    fireEvent.click(screen.getByLabelText(/confirms they received/))
    fireEvent.click(screen.getByRole('button', { name: 'Complete delivery' }))
    await waitFor(() => expect(backend.callsTo('POST /delivery/jobs/job-1/deliver')).toHaveLength(1))
  })

  it('needs a signature or photo when the job’s rule says so, and holds the button until then', async () => {
    await atTheDoor({ 'GET /driver/jobs': page(job({ isCod: false, codAmount: null, rules: { ...NONE, podRequirement: 'ARTIFACT' } })) })
    expect(screen.getByText('Proof: the customer’s signature or a photo')).toBeTruthy()
    fireEvent.click(screen.getByLabelText(/confirms they received/))
    expect(screen.getByText(/needs the customer’s signature or a photo/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Complete delivery' }).disabled).toBe(true)
  })

  it('holds a cash amount that is not the exact amount when the rule demands it', async () => {
    await atTheDoor({ 'GET /driver/jobs': page(job({ rules: { ...NONE, codCollectionRequired: true, codExactAmountRequired: true } })) })
    fireEvent.change(screen.getByLabelText('Cash received (birr)'), { target: { value: '50' } })
    fireEvent.click(screen.getByLabelText(/confirms they received/))
    expect(screen.getByText(/exact amount: ETB 57.00/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Complete delivery' }).disabled).toBe(true)
  })

  it('explains a refused delivery', async () => {
    await atTheDoor({
      'GET /driver/jobs': page(job({ isCod: false, codAmount: null })),
      'POST /delivery/jobs/job-1/proof-of-delivery': ok({}),
      'POST /delivery/jobs/job-1/deliver': fail(422, 'POD_REQUIRED', 'Proof required.'),
    })
    fireEvent.click(screen.getByLabelText(/confirms they received/))
    fireEvent.click(screen.getByRole('button', { name: 'Complete delivery' }))
    expect((await screen.findByRole('alert')).textContent).toMatch(/confirm they received/)
  })
})
