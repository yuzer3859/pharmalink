import { beforeAll, describe, expect, it } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { MotionGlobalConfig } from 'framer-motion'
import App from '../App'
import { AuthProvider } from '../auth/AuthContext'
import { createApiClient } from '../auth/apiClient'
import { createAuthService } from '../auth/authService'
import { CatalogContext, createCatalogService } from '../catalog/catalogService'
import { SearchContext, createSearchService } from '../search/searchService'
import { OrderProgress } from '../pages/OrderDetail'
import { REFRESH_A, customer, fakeFetch, ok, tokens } from '../test/fakeBackend'
import { categoryTree, detail } from '../test/catalogFixtures'

beforeAll(() => {
  MotionGlobalConfig.skipAnimations = true
})

const PRODUCT_ID = '22222222-2222-4222-8222-222222222222'
const cart = (quantity) => ({
  id: 'cart-1',
  items: quantity > 0 ? [{ id: 'item-1', cartId: 'cart-1', catalogProductId: PRODUCT_ID, quantity, indicativePrice: 2500, requiresRx: false }] : [],
  totals: null,
})

function signedInApp(path, routes) {
  sessionStorage.setItem('pharmalink.customer.session', JSON.stringify({ refreshToken: REFRESH_A }))
  const backend = fakeFetch({
    'POST /auth/token/refresh': ok(tokens('access-2', 'q'.repeat(40))),
    'GET /users/me': ok(customer),
    'GET /catalog/categories': ok(categoryTree()),
    'GET /catalog/products': ok({ items: [], meta: { page: 1, size: 4, total: 0 } }),
    [`GET /catalog/products/${PRODUCT_ID}`]: ok({ ...detail(), id: PRODUCT_ID, nameEn: 'Ibuprofen 400mg', status: 'ACTIVE', imageUrl: '/products/ibuprofen.webp' }),
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

describe('the cart drawer (Work 148)', () => {
  it('slides in with the items, their pictures and the total, and changes a quantity in place', async () => {
    const { callsTo } = signedInApp('/', {
      'GET /cart': [ok(cart(2)), ok(cart(2)), ok(cart(3))],
      'PATCH /cart/items/item-1': ok({}),
    })
    expect((await screen.findByTestId('cart-count')).textContent).toBe('2')
    fireEvent.click(screen.getByRole('button', { name: 'Cart' }))

    const drawer = await screen.findByRole('dialog', { name: 'Cart' })
    expect(await within(drawer).findByText('Ibuprofen 400mg')).toBeTruthy()
    expect(within(drawer).getByTestId('cart-item').querySelector('img').getAttribute('src')).toBe('/products/ibuprofen.webp')
    expect(within(drawer).getByTestId('drawer-subtotal').textContent).toMatch(/50\.00/)

    fireEvent.click(within(drawer).getByRole('button', { name: 'Increase quantity' }))
    await waitFor(() => expect(callsTo('PATCH /cart/items/item-1')[0].body).toEqual({ quantity: 3 }))
    await waitFor(() => expect(within(drawer).getByTestId('drawer-subtotal').textContent).toMatch(/75\.00/))
    expect(screen.getByTestId('cart-count').textContent).toBe('3')

    expect(within(drawer).getByRole('link', { name: /Go to checkout/ }).getAttribute('href')).toBe('/checkout')
  })

  it('closes with Escape or the close button, and says when the cart is empty', async () => {
    signedInApp('/', { 'GET /cart': ok(cart(0)) })
    await screen.findAllByRole('link', { name: /Antibiotics/ })
    fireEvent.click(screen.getByRole('button', { name: 'Cart' }))
    const drawer = await screen.findByRole('dialog', { name: 'Cart' })
    expect(await within(drawer).findByText('Your cart is empty.')).toBeTruthy()

    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Cart' })).toBeNull())

    fireEvent.click(screen.getByRole('button', { name: 'Cart' }))
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Cart' })).getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Cart' })).toBeNull())
  })
})

describe('the order progress (Work 148)', () => {
  it('marks the steps passed and the current one, and is not shown before payment or after a cancellation', () => {
    const { rerender } = render(<OrderProgress status="READY" />)
    const steps = within(screen.getByTestId('order-progress')).getAllByRole('listitem')
    expect(steps.map((s) => s.textContent)).toEqual(['Sent to the pharmacy', 'Pharmacy is preparing it', 'Ready for the driver', 'On the way', 'Delivered'])
    expect(steps[2].getAttribute('aria-current')).toBe('step')
    expect(steps.filter((s) => s.getAttribute('aria-current')).length).toBe(1)

    rerender(<OrderProgress status="COMPLETED" />)
    expect(screen.getByTestId('order-progress').querySelector('[aria-current]')).toBeNull()

    for (const status of ['PENDING_PAYMENT', 'CANCELLED', 'REFUNDED']) {
      rerender(<OrderProgress status={status} />)
      expect(screen.queryByTestId('order-progress')).toBeNull()
    }
  })
})
