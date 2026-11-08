import { beforeAll, describe, expect, it, vi } from 'vitest'
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
import { followDelivery } from './trackingSocket'

beforeAll(() => {
  MotionGlobalConfig.skipAnimations = true
})

const ORDER_ID = '55555555-5555-4555-8555-555555555555'
const JOB_ID = '66666666-6666-4666-8666-666666666666'
const order = (status = 'DELIVERED') => ({ id: ORDER_ID, orderNumber: 'ORD-77', status, grandTotal: 6500, currency: 'ETB', isCod: false, placedAt: '2026-11-08T08:00:00.000Z' })

function signedInApp(path, routes) {
  sessionStorage.setItem('pharmalink.customer.session', JSON.stringify({ refreshToken: REFRESH_A }))
  const backend = fakeFetch({
    'POST /auth/token/refresh': ok(tokens('access-2', 'q'.repeat(40))),
    'GET /users/me': ok(customer),
    'GET /catalog/categories': ok(categoryTree()),
    ...routes,
  })
  const api = createApiClient({ baseUrl: 'http://api.test', fetcher: backend.fetcher })
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

describe('orders (Work 102)', () => {
  it('lists the real orders and links each to its page', async () => {
    signedInApp('/orders', { 'GET /orders': ok({ items: [order('PAID')], total: 1 }) })
    expect(await screen.findByText('ORD-77')).toBeTruthy()
    expect(screen.getByText('Sent to the pharmacy')).toBeTruthy()
    expect(screen.getByRole('link', { name: /ORD-77/ }).getAttribute('href')).toBe(`/orders/${ORDER_ID}`)
  })

  it('the old tracking address shows the real orders, with no sample data', async () => {
    signedInApp('/tracking', { 'GET /orders': ok({ items: [], total: 0 }) })
    expect(await screen.findByText('You have no orders yet.')).toBeTruthy()
    expect(screen.queryByText(/Dawit|PL-48213|Bole Pharma/)).toBeNull()
  })

  it('shows the order history, the finished delivery and its proof of delivery', async () => {
    const open = vi.fn()
    vi.stubGlobal('open', open)
    const { callsTo } = signedInApp(`/orders/${ORDER_ID}`, {
      [`GET /orders/${ORDER_ID}`]: ok({
        order: order('DELIVERED'),
        lines: [{ catalogProductId: 'p', quantity: 1 }],
        statusHistory: [
          { id: 'h1', toStatus: 'PENDING_PAYMENT', createdAt: '2026-11-08T08:00:00.000Z' },
          { id: 'h2', toStatus: 'PAID', createdAt: '2026-11-08T08:00:05.000Z' },
          { id: 'h3', toStatus: 'DELIVERED', createdAt: '2026-11-08T09:00:00.000Z' },
        ],
      }),
      [`GET /tracking/orders/${ORDER_ID}`]: ok({ jobId: JOB_ID, orderId: ORDER_ID, status: 'DELIVERED', location: null, isLive: false, isFinished: true, eta: null }),
      [`GET /delivery/jobs/${JOB_ID}/proof-of-delivery`]: ok({ jobId: JOB_ID, type: 'PHOTO', recipientName: 'Almaz', recipientConfirmed: true, capturedAt: '2026-11-08T09:00:00.000Z', artifact: { contentType: 'image/png', bytes: 10, sha256: 'x', available: true } }),
      [`POST /delivery/jobs/${JOB_ID}/proof-of-delivery/artifact`]: ok({ url: 'http://storage.test/storage/local/pod', expiresAt: '2026-11-08T09:05:00.000Z' }),
    })
    expect(await screen.findByRole('heading', { name: 'ORD-77' })).toBeTruthy()
    expect(screen.getByLabelText('Order history').textContent).toMatch(/Waiting for payment.*Sent to the pharmacy.*Delivered/)
    expect(await screen.findByText(/Received by Almaz/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'View the photo' }))
    await waitFor(() => expect(open).toHaveBeenCalledWith('http://storage.test/storage/local/pod', '_blank', 'noopener'))
    expect(callsTo(`POST /delivery/jobs/${JOB_ID}/proof-of-delivery/artifact`)).toHaveLength(1)
  })

  it('before a driver is assigned, says so instead of failing', async () => {
    signedInApp(`/orders/${ORDER_ID}`, {
      [`GET /orders/${ORDER_ID}`]: ok({ order: order('READY'), lines: [], statusHistory: [] }),
      [`GET /tracking/orders/${ORDER_ID}`]: { status: 404, body: { success: false, data: null, error: { code: 'NOT_FOUND', message: 'nope' }, meta: {} } },
    })
    expect(await screen.findByText(/A driver is assigned once the pharmacy has prepared your order/)).toBeTruthy()
  })
})

describe('followDelivery', () => {
  function fakeSocket() {
    const handlers = {}
    const socket = {
      emitted: [],
      on: (event, fn) => { handlers[event] = fn },
      emit: (event, payload, ack) => { socket.emitted.push([event, payload]); if (ack) ack({ ok: true, data: { jobId: JOB_ID, status: 'EN_ROUTE' } }) },
      disconnect: vi.fn(),
      fire: (event, payload) => handlers[event]?.(payload),
    }
    return socket
  }

  it('authenticates in the handshake, subscribes on connect, and passes the snapshot and updates on', () => {
    const socket = fakeSocket()
    const connect = vi.fn(() => socket)
    const views = []
    const stop = followDelivery({ jobId: JOB_ID, token: 'access-2', onView: (v) => views.push(v), connect, baseUrl: 'http://api.test' })
    expect(connect).toHaveBeenCalledWith('http://api.test/tracking', expect.objectContaining({ auth: { token: 'access-2' }, transports: ['websocket'] }))
    socket.fire('connect')
    expect(socket.emitted[0]).toEqual(['tracking:subscribe', { jobId: JOB_ID }])
    socket.fire('tracking:update', { jobId: JOB_ID, status: 'ARRIVED_DROPOFF' })
    expect(views.map((v) => v.status)).toEqual(['EN_ROUTE', 'ARRIVED_DROPOFF'])
    stop()
    expect(socket.emitted.at(-1)).toEqual(['tracking:unsubscribe', { jobId: JOB_ID }])
    expect(socket.disconnect).toHaveBeenCalled()
  })

  it('reports a refused subscription', () => {
    const socket = fakeSocket()
    socket.emit = (event, payload, ack) => ack?.({ ok: false, error: { code: 'NOT_FOUND' } })
    const errors = []
    followDelivery({ jobId: JOB_ID, token: 't', onView: () => {}, onError: (e) => errors.push(e), connect: () => socket })
    socket.fire('connect')
    expect(errors).toEqual([{ code: 'NOT_FOUND' }])
  })
})
