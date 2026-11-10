import { describe, expect, it } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import App from './App'
import { AuthProvider } from './auth/AuthContext'
import { createApiClient } from './api/apiClient'
import { createAuthService } from './auth/authService'
import { driverProfile, driverUser, fakeFetch, ok, tokens } from './test/fakeBackend'

const delivered = (jobId, codAmount, over = {}) => ({
  jobId,
  orderId: `o-${jobId}`,
  fulfillmentId: `f-${jobId}`,
  status: 'DELIVERED',
  pickupAddress: 'Seed Bole Pharmacy',
  dropoffAddress: `Address ${jobId}`,
  isColdChain: false,
  isCod: codAmount !== null,
  codAmount,
  distanceMeters: 1000,
  pickedUpAt: null,
  deliveredAt: new Date().toISOString(),
  createdAt: new Date().toISOString(),
  ...over,
})

async function openAt(path, routes) {
  const backend = fakeFetch({ 'POST /auth/login': ok(tokens()), 'GET /users/me': ok(driverUser), 'GET /driver/profile': ok(driverProfile()), ...routes })
  const auth = createAuthService({
    api: createApiClient({ baseUrl: 'http://api.test', fetcher: backend.fetcher }),
    deviceInfo: () => ({ fingerprint: 'fp-1', platform: 'WEB' }),
  })
  render(
    <MemoryRouter initialEntries={[path]}>
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

describe('earnings and cash (Work 123)', () => {
  it('shows what is still to be paid and what was paid, per delivery', async () => {
    await openAt('/earnings', {
      'GET /driver/earnings': ok({
        items: [
          { id: 'e1', jobId: 'a', total: 3000, status: 'ACCRUED', accruedAt: new Date().toISOString() },
          { id: 'e2', jobId: 'b', total: 2500, status: 'SETTLED', accruedAt: new Date().toISOString() },
        ],
        total: 2, limit: 50, offset: 0, pageTotal: 5500, currency: 'ETB',
      }),
    })
    const totals = await screen.findByRole('region', { name: 'Totals' })
    expect(totals.textContent).toMatch(/To be paid.*ETB 30.00/)
    expect(totals.textContent).toMatch(/Paid.*ETB 25.00/)
    expect(screen.getByText('Earned, to be paid')).toBeTruthy()
  })

  it('shows the cash still with the driver and what reached PharmaLink, COD deliveries only', async () => {
    await openAt('/cash', {
      'GET /driver/jobs': ok({ items: [delivered('a', 5700), delivered('b', 4500), delivered('c', null)], offers: [], total: 3, page: 1, size: 50 }),
      'GET /delivery/jobs/a/cod-collection': ok({ jobId: 'a', collectedAmount: 5700, status: 'COLLECTED', hasDiscrepancy: false }),
      'GET /delivery/jobs/b/cod-collection': ok({ jobId: 'b', collectedAmount: 4500, status: 'REMITTED', hasDiscrepancy: false }),
    })
    const withYou = await screen.findByRole('region', { name: 'Cash with you' })
    expect(withYou.textContent).toMatch(/ETB 57.00/)
    expect(withYou.textContent).toMatch(/Handed over so far: ETB 45.00/)
    expect(screen.getByText('With you: hand it to PharmaLink')).toBeTruthy()
    expect(screen.getByText('Handed to PharmaLink')).toBeTruthy()
    expect(screen.queryByText('Address c')).toBeNull()
  })
})
