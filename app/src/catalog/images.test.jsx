import { beforeAll, describe, expect, it } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { MotionGlobalConfig } from 'framer-motion'
import App from '../App'
import { AuthProvider } from '../auth/AuthContext'
import { createApiClient } from '../auth/apiClient'
import { createAuthService } from '../auth/authService'
import { CatalogContext, createCatalogService } from './catalogService'
import { SearchContext, createSearchService } from '../search/searchService'
import ProductImage from '../components/ProductImage'
import { safeImageUrl } from './images'
import { cartChanged, cartItemCount } from '../lib/cartEvents'
import { REFRESH_A, customer, fakeFetch, ok, tokens } from '../test/fakeBackend'

beforeAll(() => {
  MotionGlobalConfig.skipAnimations = true
})

const BEAUTY_ID = '99999999-9999-4999-8999-999999999999'
const LIPSTICK_ID = '88888888-8888-4888-8888-888888888888'
const SEARCH = 'GET /search/medicines'

const beautyTree = () => [{ id: BEAUTY_ID, parentId: null, slug: 'beauty', nameAm: null, nameEn: 'Make-up & beauty', appliesTo: 'HEALTH_PRODUCT', isActive: true, children: [] }]
const lipstick = () => ({
  productId: LIPSTICK_ID,
  nameEn: 'Matte lipstick, ruby red',
  nameAm: null,
  genericName: null,
  brandName: null,
  manufacturer: null,
  strength: null,
  dosageForm: null,
  rxClassification: null,
  categories: [{ categoryId: BEAUTY_ID, slug: 'beauty', nameEn: 'Make-up & beauty', nameAm: null }],
  imageUrl: '/products/lipstick.webp',
  availability: { pharmacyCount: 1, minPrice: 45_000, currency: 'ETB', nearestDistanceMeters: null },
})

function renderApp(path, routes, { signedIn = false } = {}) {
  if (signedIn) sessionStorage.setItem('pharmalink.customer.session', JSON.stringify({ refreshToken: REFRESH_A }))
  const backend = fakeFetch({
    'POST /auth/token/refresh': ok(tokens('access-2', 'q'.repeat(40))),
    'GET /users/me': ok(customer),
    'GET /catalog/categories': ok(beautyTree()),
    'GET /catalog/products': ok({ items: [], meta: { page: 1, size: 4, total: 0 } }),
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

describe('product pictures (Work 147)', () => {
  it('shows only an https URL or a site path, never another scheme or host', () => {
    expect(safeImageUrl('/products/lipstick.webp')).toBe('/products/lipstick.webp')
    expect(safeImageUrl('https://cdn.example.et/a.jpg')).toBe('https://cdn.example.et/a.jpg')
    // Work 150: a picture uploaded by catalogue staff is served by the API.
    expect(safeImageUrl('/media/catalog/p/o')).toMatch(/^https?:\/\/[^/]+.*\/media\/catalog\/p\/o$/)
    for (const bad of ['//evil.example/a.jpg', 'http://plain.example/a.jpg', 'javascript:alert(1)', 'data:image/png;base64,AAAA', '/a b.jpg', '', null, 42]) {
      expect(safeImageUrl(bad)).toBeNull()
    }
  })

  it('falls back to a placeholder with no picture, an unsafe one, or one that fails to load', () => {
    const { container, rerender } = render(<ProductImage src={null} />)
    expect(screen.getByTestId('image-placeholder')).toBeTruthy()
    expect(container.querySelector('img')).toBeNull()

    rerender(<ProductImage key="unsafe" src="javascript:alert(1)" />)
    expect(container.querySelector('img')).toBeNull()

    rerender(<ProductImage key="good" src="/products/lipstick.webp" />)
    const img = container.querySelector('img')
    expect(img.getAttribute('src')).toBe('/products/lipstick.webp')
    expect(img.getAttribute('alt')).toBe('')
    fireEvent.error(img)
    expect(container.querySelector('img')).toBeNull()
    expect(screen.getByTestId('image-placeholder')).toBeTruthy()
  })

  it('the home page shows a shelf per category, with each product pictured and priced', async () => {
    const { callsTo } = renderApp('/', { [SEARCH]: ok({ items: [lipstick()], total: 1, page: 1, size: 10 }) })
    const shelf = await screen.findByRole('region', { name: 'Make-up & beauty' })
    const card = await within(shelf).findByRole('link', { name: /Matte lipstick, ruby red/ })
    expect(card.getAttribute('href')).toBe(`/medicines/${LIPSTICK_ID}`)
    expect(card.querySelector('img').getAttribute('src')).toBe('/products/lipstick.webp')
    expect(within(card).getByTestId('card-price').textContent).toMatch(/450\.00/)
    expect(new URL(callsTo(SEARCH)[0].url).searchParams.get('categoryId')).toBe(BEAUTY_ID)
    // The category tile carries its picture too.
    const tile = screen.getAllByRole('link', { name: /Make-up & beauty/ }).find((a) => a.getAttribute('href') === `/medicines?category=${BEAUTY_ID}`)
    expect(tile.querySelector('img').getAttribute('src')).toBe('/products/lipstick.webp')
  })

  it('hides a shelf whose products cannot be loaded', async () => {
    renderApp('/', {})
    await screen.findAllByRole('link', { name: /Make-up & beauty/ })
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Make-up & beauty' })).toBeNull())
  })
})

describe('the cart count in the top bar (Work 147)', () => {
  it('counts the items, shows nothing when the cart is empty or the customer is signed out', async () => {
    expect(cartItemCount({ items: [{ quantity: 2 }, { quantity: 1 }] })).toBe(3)
    expect(cartItemCount(null)).toBe(0)

    renderApp('/', { 'GET /cart': ok({ id: 'c1', items: [{ id: 'i1', quantity: 2 }, { id: 'i2', quantity: 1 }], totals: null }), [SEARCH]: ok({ items: [], total: 0, page: 1, size: 10 }) }, { signedIn: true })
    expect((await screen.findByTestId('cart-count')).textContent).toBe('3')
    act(() => cartChanged(0))
    await waitFor(() => expect(screen.queryByTestId('cart-count')).toBeNull())
  })

  it('shows no count to a signed-out visitor', async () => {
    renderApp('/', { [SEARCH]: ok({ items: [], total: 0, page: 1, size: 10 }) })
    await screen.findAllByRole('link', { name: /Make-up & beauty/ })
    expect(screen.queryByTestId('cart-count')).toBeNull()
  })
})
