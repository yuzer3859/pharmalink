import { beforeAll, describe, expect, it } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { MotionGlobalConfig } from 'framer-motion'
import App from '../App'
import { AuthProvider } from '../auth/AuthContext'
import { createApiClient } from '../auth/apiClient'
import { createAuthService } from '../auth/authService'
import { CatalogContext, createCatalogService } from '../catalog/catalogService'
import { SearchContext, createSearchService } from '../search/searchService'
import { REFRESH_A, customer, fail, fakeFetch, ok, tokens } from '../test/fakeBackend'
import { categoryTree, detail } from '../test/catalogFixtures'
import { newIdempotencyKey } from './ordersService'

beforeAll(() => {
  MotionGlobalConfig.skipAnimations = true
})

const PRODUCT_ID = '22222222-2222-4222-8222-222222222222'
const ADDRESS_ID = '33333333-3333-4333-8333-333333333333'
const ORDER_ID = '44444444-4444-4444-8444-444444444444'

const cartWith = (quantity = 2) => ({
  id: 'cart-1',
  items: [{ id: 'item-1', cartId: 'cart-1', catalogProductId: PRODUCT_ID, quantity, indicativePrice: 2500, requiresRx: false }],
  totals: null,
})
const address = { id: ADDRESS_ID, recipientName: 'Selam', recipientPhone: '+251911000111', city: 'Addis Ababa', addressLine: 'Bole Road 12', isDefault: true }
const quote = { rxGateResult: { allowed: true, blocked: [], usablePrescriptionLineIds: [] }, candidates: [], totals: { lines: [], subtotal: 5000, deliveryFee: 1500, platformFee: 0, discountTotal: 0, grandTotal: 6500, currency: 'ETB' } }
const placed = (over = {}) => ({ orderId: ORDER_ID, orderNumber: 'ORD-1', status: 'PAID', currency: 'ETB', grandTotal: 6500, isCod: true, payment: null, ...over })

function signedInApp(path, routes) {
  sessionStorage.setItem('pharmalink.customer.session', JSON.stringify({ refreshToken: REFRESH_A }))
  const backend = fakeFetch({
    'POST /auth/token/refresh': ok(tokens('access-2', 'q'.repeat(40))),
    'GET /users/me': ok(customer),
    'GET /catalog/categories': ok(categoryTree()),
    [`GET /catalog/products/${PRODUCT_ID}`]: ok({ ...detail(), id: PRODUCT_ID, nameEn: 'Ibuprofen 400mg', status: 'ACTIVE' }),
    'GET /addresses': ok([address]),
    'POST /checkout/quote': ok(quote),
    ...routes,
  })
  const api = createApiClient({ baseUrl: 'http://api.test', fetcher: backend.fetcher })
  render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider service={createAuthService({ api, storage: sessionStorage })}>
        <CatalogContext.Provider value={createCatalogService({ api })}>
          <SearchContext.Provider value={createSearchService({ api })}>
            <App />
          </SearchContext.Provider>
        </CatalogContext.Provider>
      </AuthProvider>
    </MemoryRouter>,
  )
  return backend
}

describe('checkout (Work 100)', () => {
  it('shows the real cart and the server quote, and places a cash-on-delivery order with an idempotency key', async () => {
    const { callsTo } = signedInApp('/checkout', { 'GET /cart': ok(cartWith()), 'POST /checkout': ok(placed(), 201) })
    expect(await screen.findByText('Ibuprofen 400mg')).toBeTruthy()
    await waitFor(() => expect(screen.getByTestId('grand-total').textContent).toMatch(/65/))
    expect(callsTo('POST /checkout/quote')[0].body).toEqual({ addressId: ADDRESS_ID })

    fireEvent.click(screen.getByRole('button', { name: 'Place order' }))
    expect(await screen.findByRole('heading', { name: 'Order placed' })).toBeTruthy()
    const body = callsTo('POST /checkout')[0].body
    expect(body).toEqual({ addressId: ADDRESS_ID, idempotencyKey: expect.stringMatching(/^app-.{8,}/) })
    expect(callsTo('POST /checkout')[0].headers.Authorization).toBe('Bearer access-2')
    expect(screen.getByText(/Pay the driver in cash/)).toBeTruthy()
  })

  it('pays through the gateway when a pay-now method is chosen', async () => {
    const { callsTo } = signedInApp('/checkout', {
      'GET /cart': ok(cartWith()),
      'POST /checkout': ok(placed({ isCod: false, payment: { paymentId: 'p-1', status: 'AUTHORIZED', providerRedirect: null } }), 201),
    })
    await screen.findByText('Ibuprofen 400mg')
    fireEvent.click(screen.getByRole('radio', { name: /Telebirr/ }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Pay and place order' }).disabled).toBe(false))
    fireEvent.click(screen.getByRole('button', { name: 'Pay and place order' }))
    expect(await screen.findByText('Payment approved.')).toBeTruthy()
    expect(callsTo('POST /checkout')[0].body.payment).toEqual({ method: 'TELEBIRR' })
  })

  it('a declined payment says the order was cancelled, and can put the items back in the cart', async () => {
    const { callsTo } = signedInApp('/checkout', {
      'GET /cart': [ok(cartWith()), ok(null), ok(cartWith())],
      'POST /checkout': fail(402, 'PAYMENT_AUTH_FAILED', 'Declined by the test gateway.', { orderId: ORDER_ID }),
      [`GET /orders/${ORDER_ID}`]: ok({ order: { id: ORDER_ID, status: 'CANCELLED' }, lines: [{ catalogProductId: PRODUCT_ID, quantity: 2 }], statusHistory: [] }),
      'POST /cart/items': ok({}, 201),
    })
    await screen.findByText('Ibuprofen 400mg')
    fireEvent.click(screen.getByRole('radio', { name: /Card/ }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Pay and place order' }).disabled).toBe(false))
    fireEvent.click(screen.getByRole('button', { name: 'Pay and place order' }))
    expect(await screen.findByText('Payment declined')).toBeTruthy()
    expect(screen.getByText(/Declined by the test gateway\. Your order was cancelled and nothing was charged\./)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Put the items back in my cart' }))
    await waitFor(() => expect(callsTo('POST /cart/items')).toHaveLength(1))
    expect(callsTo('POST /cart/items')[0].body).toEqual({ catalogProductId: PRODUCT_ID, quantity: 2 })
  })

  it('changes quantities and removes items through the API', async () => {
    const { callsTo } = signedInApp('/checkout', {
      'GET /cart': [ok(cartWith(2)), ok(cartWith(3)), ok(null)],
      'PATCH /cart/items/item-1': ok({}),
      'DELETE /cart/items/item-1': ok({}),
    })
    await screen.findByText('Ibuprofen 400mg')
    fireEvent.click(screen.getByRole('button', { name: 'Increase quantity' }))
    await waitFor(() => expect(callsTo('PATCH /cart/items/item-1')[0]?.body).toEqual({ quantity: 3 }))
    fireEvent.click(await screen.findByRole('button', { name: 'Remove' }))
    await waitFor(() => expect(callsTo('DELETE /cart/items/item-1')).toHaveLength(1))
    expect(await screen.findByText('Your cart is empty.')).toBeTruthy()
  })

  it('a prescription item blocks placing until a prescription is on file', async () => {
    signedInApp('/checkout', {
      'GET /cart': ok({ ...cartWith(), items: [{ ...cartWith().items[0], requiresRx: true }] }),
      'POST /checkout/quote': ok({ ...quote, rxGateResult: { allowed: false, blocked: [{ catalogProductId: PRODUCT_ID }], usablePrescriptionLineIds: [] } }),
    })
    expect(await screen.findByText(/A prescription is needed/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Place order' }).disabled).toBe(true)
  })

  it('says the prescription is with the pharmacist once checkout has sent it for review (Work 110)', async () => {
    signedInApp('/checkout', {
      'GET /cart': ok({ ...cartWith(), items: [{ ...cartWith().items[0], requiresRx: true }] }),
      'POST /checkout/quote': ok({
        ...quote,
        rxGateResult: { allowed: false, blocked: [{ catalogProductId: PRODUCT_ID }], usablePrescriptionLineIds: [] },
        prescriptionReview: { prescriptionId: 'rx-1', status: 'PENDING_VERIFICATION', verifyingOrganizationId: 'org-1', routedNow: true },
      }),
    })
    expect(await screen.findByText(/with the pharmacist for review/)).toBeTruthy()
    expect(screen.queryByText(/A prescription is needed/)).toBeNull()
    expect(screen.getByRole('button', { name: 'Place order' }).disabled).toBe(true)
  })

  it('the product page adds the product to the signed-in cart', async () => {
    const { callsTo } = signedInApp(`/medicines/${PRODUCT_ID}`, {
      [`GET /availability/product/${PRODUCT_ID}`]: ok([]),
      'POST /cart/items': ok({}, 201),
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Add to cart' }))
    expect(await screen.findByText(/Added\./)).toBeTruthy()
    expect(callsTo('POST /cart/items')[0].body).toEqual({ catalogProductId: PRODUCT_ID, quantity: 1 })
  })
})

describe('idempotency keys', () => {
  it('are prefixed and unique per call', () => {
    let n = 0
    expect(newIdempotencyKey(() => `id-${++n}`)).toBe('app-id-1')
    expect(newIdempotencyKey(() => `id-${++n}`)).toBe('app-id-2')
  })
})
