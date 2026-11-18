import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { MotionGlobalConfig } from 'framer-motion'
import App from '../App'
import { AuthProvider } from '../auth/AuthContext'
import { createApiClient } from '../auth/apiClient'
import { createAuthService } from '../auth/authService'
import { CatalogContext, createCatalogService } from '../catalog/catalogService'
import { REFRESH_A, customer, fakeFetch, ok, tokens } from '../test/fakeBackend'
import { categoryTree } from '../test/catalogFixtures'
import { requestStage, todayIso } from './rxRequestsService'

beforeAll(() => {
  MotionGlobalConfig.skipAnimations = true
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const REQUEST_ID = '77777777-7777-4777-8777-777777777777'
const ORDER_ID = '88888888-8888-4888-8888-888888888888'
const ADDRESS_ID = '33333333-3333-4333-8333-333333333333'
const address = { id: ADDRESS_ID, recipientName: 'Selam', recipientPhone: '+251911000111', city: 'Addis Ababa', addressLine: 'Bole Road 12', isDefault: true }

const view = (over = {}) => ({
  id: REQUEST_ID,
  status: 'OPEN',
  prescriptionId: 'rx-1',
  addressId: ADDRESS_ID,
  prescriptionIssueDate: '2026-11-18T00:00:00.000Z',
  note: null,
  expiresAt: '2026-11-18T10:30:00.000Z',
  offeredTo: 3,
  stillConsidering: 3,
  pharmacy: null,
  quote: null,
  quoteExpiresAt: null,
  orderId: null,
  closedReason: null,
  closedAt: null,
  createdAt: '2026-11-18T10:00:00.000Z',
  ...over,
})
const quote = (over = {}) => ({
  lines: [{ catalogProductId: 'p-1', name: 'Amoxicillin 500mg', quantity: 2, unitPrice: 2500, lineTotal: 5000, controlledSchedule: 'NONE', requiresRx: true }],
  subtotal: 5000,
  deliveryFee: 1500,
  platformFee: 0,
  grandTotal: 6500,
  currency: 'ETB',
  paperRequired: false,
  prescriptionIssueDate: '2026-11-18',
  note: 'Generic brand',
  ...over,
})
const quoted = (over = {}) => view({ status: 'QUOTED', pharmacy: { name: 'Bole Pharmacy', acceptedAt: '2026-11-18T10:02:00.000Z', quoteDueAt: null }, quote: quote(over), quoteExpiresAt: '2026-11-18T10:40:00.000Z' })

function signedInApp(path, routes) {
  sessionStorage.setItem('pharmalink.customer.session', JSON.stringify({ refreshToken: REFRESH_A }))
  const backend = fakeFetch({
    'POST /auth/token/refresh': ok(tokens('access-2', 'q'.repeat(40))),
    'GET /users/me': ok(customer),
    'GET /catalog/categories': ok(categoryTree()),
    'GET /addresses': ok([address]),
    ...routes,
  })
  const api = createApiClient({ baseUrl: 'http://api.test', fetcher: backend.fetcher })
  vi.stubGlobal('fetch', backend.fetcher)
  render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider service={createAuthService({ api, storage: sessionStorage })}>
        <CatalogContext.Provider value={createCatalogService({ api })}>
          <App />
        </CatalogContext.Provider>
      </AuthProvider>
    </MemoryRouter>,
  )
  return backend
}

describe('sending a prescription to nearby pharmacies (Work 138)', () => {
  it('uploads the prescription, takes its date and the address, and sends it', async () => {
    const { callsTo } = signedInApp('/requests/new', {
      'POST /prescriptions/uploads': ok({ fileRef: 'prescriptions/c/f.pdf', upload: { url: 'http://storage.test/storage/local/tok', method: 'PUT', headers: { 'Content-Type': 'application/pdf' } } }, 201),
      'PUT /storage/local/tok': ok({}),
      'POST /prescriptions': ok({ id: 'rx-1', status: 'UPLOADED' }, 201),
      'POST /rx-requests': ok(view(), 201),
      [`GET /rx-requests/${REQUEST_ID}`]: ok(view()),
    })
    expect(await screen.findByRole('heading', { name: 'Send a prescription' })).toBeTruthy()
    const send = screen.getByRole('button', { name: /Send to nearby pharmacies/ })
    expect(send.disabled).toBe(true)

    fireEvent.change(screen.getByLabelText('Prescription file'), { target: { files: [new File(['%PDF-1.4'], 'rx.pdf', { type: 'application/pdf' })] } })
    expect(await screen.findByText(/Prescription attached/)).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Note for the pharmacist'), { target: { value: 'Generic is fine' } })
    await waitFor(() => expect(screen.getByRole('button', { name: /Send to nearby pharmacies/ }).disabled).toBe(false))
    fireEvent.click(screen.getByRole('button', { name: /Send to nearby pharmacies/ }))

    expect(await screen.findByText(/Sent to 3 pharmacies nearby; 3 still considering it/)).toBeTruthy()
    expect(callsTo('POST /rx-requests')[0].body).toEqual({ prescriptionId: 'rx-1', addressId: ADDRESS_ID, prescriptionIssueDate: todayIso(), note: 'Generic is fine' })
  })

  it('a quote shows the medicines and total; confirming with cash on delivery opens the order', async () => {
    const { callsTo } = signedInApp(`/requests/${REQUEST_ID}`, {
      [`GET /rx-requests/${REQUEST_ID}`]: ok(quoted()),
      [`POST /rx-requests/${REQUEST_ID}/confirm`]: ok({ request: view({ status: 'CONFIRMED', orderId: ORDER_ID }), orderId: ORDER_ID }),
      [`GET /orders/${ORDER_ID}`]: ok({ order: { id: ORDER_ID, orderNumber: 'ORD-9', status: 'PAID', grandTotal: 6500, currency: 'ETB', isCod: true }, lines: [], statusHistory: [] }),
    })
    expect(await screen.findByText(/Bole Pharmacy offers/)).toBeTruthy()
    expect(screen.getByText('2 × Amoxicillin 500mg')).toBeTruthy()
    expect(screen.getByTestId('quote-total').textContent).toMatch(/65/)
    expect(screen.getByText(/You keep your paper prescription/)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Confirm and place order' }))
    expect(await screen.findByRole('heading', { name: 'ORD-9' })).toBeTruthy()
    expect(callsTo(`POST /rx-requests/${REQUEST_ID}/confirm`)[0].body).toEqual({})
  })

  it('a quote that needs the original paper says so; paying now sends the method; declining ends it', async () => {
    const { callsTo } = signedInApp(`/requests/${REQUEST_ID}`, {
      [`GET /rx-requests/${REQUEST_ID}`]: [ok(quoted({ paperRequired: true })), ok(view({ status: 'CANCELLED', closedReason: 'quote-declined-by-customer' }))],
      [`POST /rx-requests/${REQUEST_ID}/decline-quote`]: ok(view({ status: 'CANCELLED' })),
    })
    expect(await screen.findByText(/Keep the original paper prescription ready/)).toBeTruthy()
    fireEvent.click(screen.getByRole('radio', { name: /Telebirr/ }))
    expect(screen.getByRole('button', { name: 'Pay and place order' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /Decline/ }))
    expect(await screen.findByText(/You declined the pharmacy’s quote/)).toBeTruthy()
    expect(callsTo(`POST /rx-requests/${REQUEST_ID}/decline-quote`)).toHaveLength(1)
    expect(screen.getByRole('link', { name: 'send a new request' })).toBeTruthy()
  })

  it('an open request can be cancelled, and the list links each request', async () => {
    const { callsTo } = signedInApp('/requests', {
      'GET /rx-requests': ok({ items: [view({ status: 'CLAIMED', pharmacy: { name: 'Bole Pharmacy', acceptedAt: null, quoteDueAt: null } })], total: 1 }),
    })
    expect(await screen.findByText('Bole Pharmacy accepted it')).toBeTruthy()
    expect(screen.getByRole('link', { name: /Bole Pharmacy/ }).getAttribute('href')).toBe(`/requests/${REQUEST_ID}`)
    expect(callsTo('GET /rx-requests')).toHaveLength(1)
  })
})

describe('requestStage', () => {
  it('has words for every status', () => {
    for (const status of ['OPEN', 'CLAIMED', 'QUOTED', 'CONFIRMED', 'CANCELLED', 'EXPIRED', 'NO_PHARMACY']) {
      expect(requestStage(view({ status })).title.length).toBeGreaterThan(3)
    }
    expect(requestStage(view({ status: 'EXPIRED', closedReason: 'quote-not-answered-in-time' })).body).toMatch(/not confirmed in time/)
  })
})
