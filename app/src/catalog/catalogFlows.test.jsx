import { beforeAll, describe, expect, it } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { MotionGlobalConfig } from 'framer-motion'
import App from '../App'
import { AuthProvider } from '../auth/AuthContext'
import { createApiClient } from '../auth/apiClient'
import { createAuthService } from '../auth/authService'
import { CatalogContext, createCatalogService } from './catalogService'
import { fail, fakeFetch, ok } from '../test/fakeBackend'
import {
  BRANCH_ID, CATEGORY_ID, CHILD_CATEGORY_ID, HEALTH_CATEGORY_ID, LISTING_ID, PHARMACY_ID, PRODUCT_2_ID, PRODUCT_ID,
  categoryTree, detail, listing, page, summary,
} from '../test/catalogFixtures'

beforeAll(() => {
  MotionGlobalConfig.skipAnimations = true
})

const PRODUCTS = 'GET /catalog/products'
const CATEGORIES = 'GET /catalog/categories'
const DETAIL = `GET /catalog/products/${PRODUCT_ID}`
const AVAILABILITY = `GET /availability/product/${PRODUCT_ID}`

function renderApp(path, routes) {
  const backend = fakeFetch({ [CATEGORIES]: ok(categoryTree()), ...routes })
  const catalog = createCatalogService({ api: createApiClient({ baseUrl: 'http://api.test', fetcher: backend.fetcher }) })
  const auth = createAuthService({ api: createApiClient({ baseUrl: 'http://api.test', fetcher: backend.fetcher }), storage: sessionStorage })
  render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider service={auth}>
        <CatalogContext.Provider value={catalog}>
          <App />
        </CatalogContext.Provider>
      </AuthProvider>
    </MemoryRouter>,
  )
  return backend
}

const params = (call) => Object.fromEntries(new URL(call.url).searchParams)
const main = () => screen.getByRole('main')
const MOCK_NAMES = /Amoxicillin 500mg|Paracetamol 500mg|Kenema Pharmacy|Bole Pharma/

describe('medicine listing', () => {
  it('renders real API results and links each card to its detail page', async () => {
    const { callsTo } = renderApp('/medicines', {
      [PRODUCTS]: ok(page([summary(), summary({ id: PRODUCT_2_ID, type: 'HEALTH_PRODUCT', nameEn: 'Hand sanitiser', rxClassification: null, genericName: null, dosageForm: null, strengthValue: null })])),
    })
    expect(screen.getByText('Loading products…')).toBeTruthy()
    const card = await screen.findByRole('link', { name: /Amoxil 500 mg capsules/ })
    expect(card.getAttribute('href')).toBe(`/medicines/${PRODUCT_ID}`)
    expect(within(card).getByText('Rx required')).toBeTruthy()
    expect(within(card).getByText('Amoxicillin · Capsule · 500 mg')).toBeTruthy()
    expect(within(screen.getByRole('link', { name: /Hand sanitiser/ })).getByText('Health product')).toBeTruthy()
    expect(screen.getByText('2')).toBeTruthy()
    expect(params(callsTo(PRODUCTS)[0])).toEqual({ size: '20' })
    // No fake price, rating, pharmacy, stock, distance or working "Add" button.
    expect(within(main()).queryByRole('button', { name: /^Add$/ })).toBeNull()
    expect(main().textContent).not.toMatch(/ETB|★|In stock|Nearby|km\b/)
    expect(main().textContent).not.toMatch(MOCK_NAMES)
  })

  it('debounces typing into one search request and clears it again', async () => {
    const { callsTo } = renderApp('/medicines', { [PRODUCTS]: ok(page([summary()])) })
    await screen.findByRole('link', { name: /Amoxil/ })
    const box = screen.getByRole('searchbox', { name: 'Search products' })
    fireEvent.change(box, { target: { value: 'a' } })
    fireEvent.change(box, { target: { value: 'am' } })
    fireEvent.change(box, { target: { value: 'amox' } })
    await waitFor(() => expect(callsTo(PRODUCTS)).toHaveLength(2), { timeout: 2000 })
    expect(params(callsTo(PRODUCTS)[1])).toEqual({ q: 'amox', size: '20' })

    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }))
    await waitFor(() => expect(callsTo(PRODUCTS)).toHaveLength(3))
    expect(params(callsTo(PRODUCTS)[2])).toEqual({ size: '20' })
    expect(box.value).toBe('')
  })

  it('never lets a slow earlier response overwrite newer results', async () => {
    let releaseFirst
    const first = new Promise((resolve) => { releaseFirst = resolve })
    renderApp('/medicines', {
      [PRODUCTS]: (req) => (new URL(req.url).searchParams.get('q')
        ? ok(page([summary({ nameEn: 'Newer result' })]))
        : first.then(() => ok(page([summary({ nameEn: 'Stale result' })])))),
    })
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search products' }), { target: { value: 'newer' } })
    expect(await screen.findByText('Newer result', {}, { timeout: 2000 })).toBeTruthy()
    await act(async () => { releaseFirst() })
    await new Promise((r) => setTimeout(r, 20))
    expect(screen.queryByText('Stale result')).toBeNull()
    expect(screen.getByText('Newer result')).toBeTruthy()
  })

  it('filters by type, Rx/OTC, real category ids and sort, using only supported parameters', async () => {
    const { callsTo } = renderApp('/medicines', { [PRODUCTS]: ok(page([summary()])) })
    await screen.findByRole('link', { name: /Amoxil/ })
    fireEvent.click(screen.getByRole('button', { name: 'Medicines' }))
    await waitFor(() => expect(params(callsTo(PRODUCTS).at(-1))).toEqual({ type: 'MEDICINE', size: '20' }))
    fireEvent.click(screen.getByRole('button', { name: 'Over the counter' }))
    await waitFor(() => expect(params(callsTo(PRODUCTS).at(-1))).toMatchObject({ rx: 'OTC' }))

    const category = screen.getByRole('combobox', { name: 'Category' })
    const options = within(category).getAllByRole('option').map((o) => o.textContent.trim())
    expect(options).toEqual(['All categories', 'Antibiotics', 'Penicillins'])
    fireEvent.change(category, { target: { value: CHILD_CATEGORY_ID } })
    await waitFor(() => expect(params(callsTo(PRODUCTS).at(-1))).toMatchObject({ categoryId: CHILD_CATEGORY_ID }))
    expect(screen.getByText(/assigned directly to this category/)).toBeTruthy()

    fireEvent.change(screen.getByRole('combobox', { name: 'Sort' }), { target: { value: 'name_asc' } })
    await waitFor(() => expect(params(callsTo(PRODUCTS).at(-1))).toEqual({
      type: 'MEDICINE', rx: 'OTC', categoryId: CHILD_CATEGORY_ID, sort: 'name_asc', size: '20',
    }))
    // The prototype's unsupported filters are gone.
    expect(screen.queryByRole('button', { name: /In stock|Nearby/ })).toBeNull()
    expect(screen.queryByRole('option', { name: /Price|Rating/ })).toBeNull()

    // Switching to health products drops the medicine-only category and lists only matching ones.
    fireEvent.click(screen.getByRole('button', { name: 'Health products' }))
    await waitFor(() => expect(params(callsTo(PRODUCTS).at(-1)).categoryId).toBeUndefined())
    expect(within(category).getAllByRole('option').map((o) => o.textContent.trim())).toEqual(['All categories', 'Personal care'])
    expect(HEALTH_CATEGORY_ID).toBeTruthy()
  })

  it('paginates with the backend total', async () => {
    const { callsTo } = renderApp('/medicines', {
      [PRODUCTS]: (req) => ok(page([summary()], { total: 45, page: Number(new URL(req.url).searchParams.get('page') ?? 1) })),
    })
    expect(await screen.findByText('Page 1 of 3')).toBeTruthy()
    expect(screen.getByRole('button', { name: /Previous/ }).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: /Next/ }))
    expect(await screen.findByText('Page 2 of 3')).toBeTruthy()
    expect(params(callsTo(PRODUCTS).at(-1))).toEqual({ page: '2', size: '20' })
  })

  it('distinguishes an empty catalog from a search with no results', async () => {
    renderApp('/medicines', { [PRODUCTS]: ok(page([])) })
    expect(await screen.findByText('The catalog has no products yet.')).toBeTruthy()
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search products' }), { target: { value: 'zzz' } })
    expect(await screen.findByText('No products match your search.', {}, { timeout: 2000 })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Clear search and filters' })).toBeTruthy()
  })

  it('shows an error with retry, never mock data or "no products", when the API fails', async () => {
    const { callsTo } = renderApp('/medicines', { [PRODUCTS]: ['NETWORK', ok({ items: 'bad' }), ok(page([summary()]))] })
    expect((await screen.findByRole('alert')).textContent).toMatch(/could not be reached/)
    expect(main().textContent).not.toMatch(/No products|no products yet/)
    expect(main().textContent).not.toMatch(MOCK_NAMES)
    fireEvent.click(screen.getByRole('button', { name: /Try again/ }))
    expect((await screen.findByRole('alert')).textContent).toMatch(/returned an error/)
    fireEvent.click(screen.getByRole('button', { name: /Try again/ }))
    expect(await screen.findByRole('link', { name: /Amoxil/ })).toBeTruthy()
    expect(callsTo(PRODUCTS)).toHaveLength(3)
  })

  it('keeps the search context when going to a product and back', async () => {
    renderApp(`/medicines?q=amox&rx=RX`, {
      [PRODUCTS]: ok(page([summary()])),
      [DETAIL]: ok(detail()),
      [AVAILABILITY]: ok([]),
    })
    fireEvent.click(await screen.findByRole('link', { name: /Amoxil 500 mg capsules/ }))
    const back = await screen.findByRole('link', { name: /Back to medicines/ })
    expect(back.getAttribute('href')).toBe('/medicines?q=amox&rx=RX')
    fireEvent.click(back)
    expect((await screen.findByRole('searchbox', { name: 'Search products' })).value).toBe('amox')
    expect(screen.getByRole('button', { name: 'Prescription (Rx)' }).getAttribute('aria-pressed')).toBe('true')
  })
})

describe('product detail and availability', () => {
  it('shows the backend fields, RX classification and warnings, and labels the reference price correctly', async () => {
    renderApp(`/medicines/${PRODUCT_ID}`, { [DETAIL]: ok(detail()), [AVAILABILITY]: ok([]) })
    expect(await screen.findByRole('heading', { level: 1, name: 'Amoxil 500 mg capsules' })).toBeTruthy()
    expect(screen.getByText('Prescription only (Rx)')).toBeTruthy()
    expect(screen.getByText(/Prescription-only medicine/)).toBeTruthy()
    expect(screen.getByText('21 capsules')).toBeTruthy()
    expect(screen.getByText('500 mg')).toBeTruthy()
    expect(screen.getByText('Ambient')).toBeTruthy()
    expect(screen.getByText('Test warning text.')).toBeTruthy()
    expect(screen.getByText('Catalog description text.')).toBeTruthy()
    expect(screen.getByText(/not medical advice/)).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Antibiotics' }).getAttribute('href')).toBe(`/medicines?category=${CATEGORY_ID}`)
    const reference = screen.getByText('Catalog reference price').closest('div')
    expect(reference.textContent).toMatch(/ETB 250\.00/)
    expect(reference.textContent).toMatch(/not a pharmacy selling price/)
    expect(screen.queryByText(/selling price/i, { selector: 'p' })).toBeNull()
  })

  it('aggregates real availability: count and selling-price range, with no pharmacy names or ids', async () => {
    renderApp(`/medicines/${PRODUCT_ID}`, {
      [DETAIL]: ok(detail()),
      [AVAILABILITY]: ok([listing({ price: 28000 }), listing({ price: 31050, listingId: '99999999-9999-4999-8999-999999999999' })]),
    })
    expect(await screen.findByText('2 available listings')).toBeTruthy()
    expect(screen.getByText('Pharmacy selling prices')).toBeTruthy()
    expect(screen.getByText('ETB 280.00 – ETB 310.50')).toBeTruthy()
    const text = document.body.textContent
    for (const id of [PHARMACY_ID, BRANCH_ID, LISTING_ID]) expect(text).not.toContain(id)
    expect(text).not.toMatch(MOCK_NAMES)
    expect(text).not.toMatch(/\bkm\b|nearby|away/i)
  })

  it('shows an honest empty state, and an availability failure that is not "out of stock"', async () => {
    renderApp(`/medicines/${PRODUCT_ID}`, { [DETAIL]: ok(detail()), [AVAILABILITY]: [ok([]), fail(500, 'INTERNAL_ERROR')] })
    expect(await screen.findByText(/No pharmacy listings are available/)).toBeTruthy()
    // No selling price is shown without a listing (the reference price keeps its own label).
    expect(screen.queryByText(/^Pharmacy selling prices?$/)).toBeNull()

    document.body.innerHTML = ''
    renderApp(`/medicines/${PRODUCT_ID}`, { [DETAIL]: ok(detail()), [AVAILABILITY]: fail(500, 'INTERNAL_ERROR') })
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toMatch(/could not be checked/)
    expect(alert.textContent).toMatch(/does not mean the product is out of stock/)
    expect(screen.queryByText(/No pharmacy listings/)).toBeNull()
  })

  it('never offers an online-sale-prohibited product and does not query its availability', async () => {
    const { callsTo } = renderApp(`/medicines/${PRODUCT_ID}`, {
      [DETAIL]: ok(detail({ onlineSaleProhibited: true, controlledSchedule: 'SCHEDULE_2' })),
      [AVAILABILITY]: ok([listing()]),
    })
    expect(await screen.findByText('Not available for online sale')).toBeTruthy()
    expect(screen.getByText('Controlled: Schedule 2')).toBeTruthy()
    expect(callsTo(AVAILABILITY)).toHaveLength(0)
  })

  it('shows OTC products and a deprecated notice', async () => {
    renderApp(`/medicines/${PRODUCT_ID}`, {
      [DETAIL]: ok(detail({ rxClassification: 'OTC', status: 'DEPRECATED', warnings: null, price: null })),
      [AVAILABILITY]: ok([]),
    })
    expect(await screen.findByText('Over the counter (OTC)')).toBeTruthy()
    expect(screen.getByText(/discontinued in the PharmaLink catalog/)).toBeTruthy()
    expect(screen.queryByText(/Prescription-only medicine/)).toBeNull()
    expect(screen.queryByText('Warnings')).toBeNull()
    expect(screen.queryByText('Catalog reference price')).toBeNull()
  })

  it('shows not-found for a 404 and for a malformed id, and an error with retry otherwise', async () => {
    renderApp(`/medicines/${PRODUCT_ID}`, { [DETAIL]: fail(404, 'NOT_FOUND') })
    expect(await screen.findByText('Product not found')).toBeTruthy()

    document.body.innerHTML = ''
    const { calls } = renderApp('/medicines/not-a-product', {})
    expect(await screen.findByText('Product not found')).toBeTruthy()
    expect(calls.filter((c) => c.key.startsWith('GET /catalog/products'))).toHaveLength(0)

    document.body.innerHTML = ''
    renderApp(`/medicines/${PRODUCT_ID}`, { [DETAIL]: ['NETWORK', ok(detail())], [AVAILABILITY]: ok([]) })
    expect(await screen.findByText("We couldn't load this product.")).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Try again/ }))
    expect(await screen.findByRole('heading', { level: 1, name: 'Amoxil 500 mg capsules' })).toBeTruthy()
  })
})

describe('home page', () => {
  it('features real catalog products and categories that link to real routes', async () => {
    const { callsTo } = renderApp('/', { [PRODUCTS]: ok(page([summary()])) })
    const card = await screen.findByRole('link', { name: /Amoxil 500 mg capsules/ })
    expect(card.getAttribute('href')).toBe(`/medicines/${PRODUCT_ID}`)
    expect(params(callsTo(PRODUCTS)[0])).toEqual({ sort: 'newest', size: '4' })
    expect((await screen.findByRole('link', { name: 'Antibiotics' })).getAttribute('href')).toBe(`/medicines?category=${CATEGORY_ID}`)
    expect(main().textContent).not.toMatch(MOCK_NAMES)
    expect(main().textContent).not.toMatch(/Bole, Addis Ababa/)
    expect(screen.getByText(/doctor booking is a design prototype/)).toBeTruthy()
  })

  it('shows empty and failure states without falling back to mock medicines', async () => {
    renderApp('/', { [PRODUCTS]: ok(page([])), [CATEGORIES]: ok([]) })
    expect(await screen.findByText('The catalog has no products yet.')).toBeTruthy()
    expect(screen.getByText('No categories have been set up in the catalog yet.')).toBeTruthy()

    document.body.innerHTML = ''
    renderApp('/', { [PRODUCTS]: 'NETWORK', [CATEGORIES]: 'NETWORK' })
    expect(await screen.findByText('Products could not be loaded from the catalog.')).toBeTruthy()
    expect(main().textContent).not.toMatch(MOCK_NAMES)
  })

  it('sends the hero search to the live catalog search', async () => {
    const { callsTo } = renderApp('/', { [PRODUCTS]: ok(page([summary()])) })
    const form = within(main()).getAllByRole('search')[0]
    fireEvent.change(within(form).getByRole('searchbox'), { target: { value: 'amox' } })
    fireEvent.submit(form)
    expect(await screen.findByRole('heading', { name: 'Medicines & health products' })).toBeTruthy()
    await waitFor(() => expect(params(callsTo(PRODUCTS).at(-1))).toEqual({ q: 'amox', size: '20' }))
  })
})
