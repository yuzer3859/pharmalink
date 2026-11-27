import { beforeAll, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { MotionGlobalConfig } from 'framer-motion'
import App from '../App'
import { AuthProvider } from '../auth/AuthContext'
import { createApiClient } from '../auth/apiClient'
import { createAuthService } from '../auth/authService'
import { CatalogContext, createCatalogService } from '../catalog/catalogService'
import { SearchContext, buildMedicineSearchQuery, createSearchService, requestLocation } from './searchService'
import { fakeFetch, fail, ok } from '../test/fakeBackend'
import { categoryTree } from '../test/catalogFixtures'

beforeAll(() => {
  MotionGlobalConfig.skipAnimations = true
})

const PRODUCT_ID = '11111111-1111-4111-8111-111111111111'
const SEARCH = 'GET /search/medicines'

const hit = (over = {}) => ({
  productId: PRODUCT_ID,
  nameEn: 'Ibuprofen 400mg',
  nameAm: 'ኢቡፕሮፌን',
  genericName: 'Ibuprofen',
  brandName: null,
  manufacturer: 'Acme',
  strength: '400MG',
  dosageForm: 'TABLET',
  rxClassification: 'OTC',
  categories: [],
  availability: { pharmacyCount: 2, minPrice: 2500, currency: 'ETB', nearestDistanceMeters: null },
  ...over,
})
const results = (items) => ({ items, total: items.length, page: 1, size: 20 })

function renderApp(path, routes) {
  const backend = fakeFetch({ 'GET /catalog/categories': ok(categoryTree()), ...routes })
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

const params = (call) => Object.fromEntries(new URL(call.url).searchParams)

describe('search page (Work 99)', () => {
  it('searches the real API and shows each result with its live availability', async () => {
    const { callsTo } = renderApp('/search?q=ibu', { [SEARCH]: ok(results([hit()])) })
    expect(await screen.findByText('Ibuprofen 400mg')).toBeTruthy()
    expect(screen.getByText('ኢቡፕሮፌን')).toBeTruthy()
    expect(screen.getByTestId('availability').textContent).toMatch(/2 pharmacies · from/)
    expect(params(callsTo(SEARCH)[0])).toEqual({ q: 'ibu', size: '20' })
    expect(screen.getByRole('link', { name: /Ibuprofen 400mg/ }).getAttribute('href')).toBe(`/medicines/${PRODUCT_ID}`)
  })

  it('debounces typing into one request and sends the Rx filter', async () => {
    const { callsTo } = renderApp('/search', { [SEARCH]: ok(results([])) })
    await screen.findByText(/No medicines match/)
    fireEvent.change(screen.getByRole('combobox', { name: 'Search medicines' }), { target: { value: 'ፓራ' } })
    await waitFor(() => expect(callsTo(SEARCH).some((c) => params(c).q === 'ፓራ')).toBe(true))
    fireEvent.click(screen.getByRole('button', { name: 'Prescription (Rx)' }))
    await waitFor(() => expect(params(callsTo(SEARCH).at(-1))).toMatchObject({ q: 'ፓራ', rx: 'RX' }))
  })

  it('says when a medicine is not available, and offers a retry when search fails', async () => {
    renderApp('/search?q=ibu', {
      [SEARCH]: [fail(503, 'SEARCH_BACKEND_UNAVAILABLE'), ok(results([hit({ availability: { pharmacyCount: 0, minPrice: null, currency: 'ETB', nearestDistanceMeters: null } })]))],
    })
    fireEvent.click(await screen.findByRole('button', { name: /Try again/ }))
    expect(await screen.findByText(/Not available right now/)).toBeTruthy()
  })

  it('asks for the location only on "Near me" and sends it with the search', async () => {
    const geolocation = { getCurrentPosition: vi.fn((ok) => ok({ coords: { latitude: 9.0301, longitude: 38.7468 } })) }
    vi.stubGlobal('navigator', { ...navigator, geolocation })
    const { callsTo } = renderApp('/search?q=ibu', { [SEARCH]: ok(results([hit({ availability: { pharmacyCount: 1, minPrice: 2500, currency: 'ETB', nearestDistanceMeters: 850 } })])) })
    await screen.findByText('Ibuprofen 400mg')
    expect(geolocation.getCurrentPosition).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: /Near me/ }))
    await waitFor(() => expect(params(callsTo(SEARCH).at(-1))).toMatchObject({ lat: '9.0301', lng: '38.7468', radiusKm: '25' }))
    expect(await screen.findByText(/nearest 850 m/)).toBeTruthy()
  })

  it('the header search box opens the search page', async () => {
    const { callsTo } = renderApp('/', { [SEARCH]: ok(results([])), 'GET /catalog/products': ok({ items: [], meta: { total: 0, page: 1, size: 4 } }) })
    const boxes = await screen.findAllByPlaceholderText('Search medicines and health products…')
    fireEvent.change(boxes[0], { target: { value: 'amox' } })
    fireEvent.submit(boxes[0].closest('form'))
    await waitFor(() => expect(callsTo(SEARCH).some((c) => params(c).q === 'amox')).toBe(true))
  })
})

describe('suggestions, close spellings and popular searches (Work 159)', () => {
  const SUGGEST = 'GET /search/suggest'
  const TRENDING = 'GET /search/trending'
  const suggestions = ok({
    items: [
      { kind: 'QUERY', text: 'ibuprofen 400', id: null, subtitle: null, imageUrl: null },
      { kind: 'PRODUCT', text: 'Ibuprofen 400mg', id: PRODUCT_ID, subtitle: 'ኢቡፕሮፌን', imageUrl: null },
      { kind: 'PHARMACY', text: 'Ibex Pharmacy', id: '22222222-2222-4222-8222-222222222222', subtitle: null, imageUrl: null },
      { kind: 'PRODUCT', text: 'Broken', id: 'not-a-uuid' },
    ],
  })

  it('offers popular searches and products while typing; pharmacies and malformed items are left out', async () => {
    const { callsTo } = renderApp('/search', { [SEARCH]: ok(results([])), [TRENDING]: ok({ items: [] }), [SUGGEST]: suggestions })
    const box = await screen.findByRole('combobox', { name: 'Search medicines' })
    fireEvent.change(box, { target: { value: 'i' } })
    fireEvent.change(box, { target: { value: 'ibu' } })
    const options = await screen.findAllByRole('option')
    expect(options.map((o) => o.textContent)).toEqual(['ibuprofen 400Popular search', 'Ibuprofen 400mgኢቡፕሮፌን'])
    expect(box.getAttribute('aria-expanded')).toBe('true')
    expect(callsTo(SUGGEST).map(params)).toEqual([{ q: 'ibu', limit: '8' }])

    // Picking a popular search runs it.
    fireEvent.mouseDown(options[0])
    await waitFor(() => expect(callsTo(SEARCH).some((c) => params(c).q === 'ibuprofen 400')).toBe(true))
    expect(screen.queryByRole('option')).toBeNull()
  })

  it('arrow keys and Enter open a suggested product', async () => {
    const { callsTo } = renderApp('/search', {
      [SEARCH]: ok(results([])),
      [TRENDING]: ok({ items: [] }),
      [SUGGEST]: suggestions,
      [`GET /catalog/products/${PRODUCT_ID}`]: fail(404, 'NOT_FOUND'),
      [`GET /availability/product/${PRODUCT_ID}`]: ok({ items: [] }),
    })
    const box = await screen.findByRole('combobox', { name: 'Search medicines' })
    fireEvent.change(box, { target: { value: 'ibu' } })
    await screen.findAllByRole('option')
    fireEvent.keyDown(box, { key: 'ArrowDown' })
    fireEvent.keyDown(box, { key: 'ArrowDown' })
    expect(screen.getAllByRole('option')[1].getAttribute('aria-selected')).toBe('true')
    expect(box.getAttribute('aria-activedescendant')).toBe(screen.getAllByRole('option')[1].id)
    fireEvent.keyDown(box, { key: 'Enter' })
    await waitFor(() => expect(callsTo(`GET /catalog/products/${PRODUCT_ID}`).length).toBeGreaterThan(0))
  })

  it('Escape closes the list, and a failed suggestion request shows none', async () => {
    renderApp('/search', { [SEARCH]: ok(results([])), [TRENDING]: ok({ items: [] }), [SUGGEST]: [suggestions, fail(503, 'SEARCH_BACKEND_UNAVAILABLE')] })
    const box = await screen.findByRole('combobox', { name: 'Search medicines' })
    fireEvent.change(box, { target: { value: 'ibu' } })
    await screen.findAllByRole('option')
    fireEvent.keyDown(box, { key: 'Escape' })
    expect(screen.queryByRole('option')).toBeNull()
    fireEvent.change(box, { target: { value: 'ibup' } })
    await waitFor(() => expect(box.getAttribute('aria-expanded')).toBe('false'))
    expect(screen.queryByRole('option')).toBeNull()
  })

  it('says when results are for a close spelling, and can search for that name', async () => {
    const { callsTo } = renderApp('/search?q=ibuprofin', {
      [SEARCH]: (req) => ok({ ...results([hit()]), match: params(req).q === 'ibuprofin' ? 'SIMILAR' : 'EXACT', didYouMean: params(req).q === 'ibuprofin' ? 'Ibuprofen 400mg' : null }),
    })
    expect(await screen.findByText('Nothing matched “ibuprofin” exactly. Showing results for “Ibuprofen 400mg”.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Search for “Ibuprofen 400mg”' }))
    await waitFor(() => expect(params(callsTo(SEARCH).at(-1)).q).toBe('Ibuprofen 400mg'))
    await waitFor(() => expect(screen.queryByText(/Showing results for/)).toBeNull())
    expect(screen.getByRole('combobox', { name: 'Search medicines' }).value).toBe('Ibuprofen 400mg')
  })

  it('shows this week’s popular searches while the box is empty, and runs one when tapped', async () => {
    const { callsTo } = renderApp('/search', { [SEARCH]: ok(results([])), [TRENDING]: ok({ items: [{ term: 'paracetamol', searches: 9 }, { term: '', searches: 2 }] }) })
    const chip = await screen.findByRole('button', { name: 'paracetamol' })
    expect(screen.getByRole('group', { name: 'Popular this week' })).toBeTruthy()
    expect(params(callsTo(TRENDING)[0])).toEqual({ limit: '8' })
    fireEvent.click(chip)
    await waitFor(() => expect(callsTo(SEARCH).some((c) => params(c).q === 'paracetamol')).toBe(true))
    await waitFor(() => expect(screen.queryByRole('group', { name: 'Popular this week' })).toBeNull())
  })

  it('popular searches stay hidden when they cannot be read', async () => {
    renderApp('/search', { [SEARCH]: ok(results([])) })
    await screen.findByText(/No medicines match/)
    expect(screen.queryByRole('group', { name: 'Popular this week' })).toBeNull()
  })
})

describe('deferred services (Work 99)', () => {
  // Work 165: /diagnostics now compares real tests (care/careFlows.test.jsx); doctors are still to come.
  it.each([['/doctors', 'Doctor appointments']])('%s says "coming later" and shows no sample data', async (path, title) => {
    renderApp(path, {})
    expect(await screen.findByRole('heading', { name: title })).toBeTruthy()
    expect(screen.getByText(/Coming later/)).toBeTruthy()
    expect(screen.queryByText(/Dr\. |Selamawit|Complete Blood Count|Pioneer Diagnostic/)).toBeNull()
  })
})

describe('search query building', () => {
  it('sends only validated parameters', () => {
    expect(buildMedicineSearchQuery({ q: '  ibu  ', rx: 'CONTROLLED', categoryId: 'nope', page: 0 })).toBe('q=ibu&size=20')
    expect(buildMedicineSearchQuery({ location: { lat: 9.03, lng: 38.74 }, availableOnly: true, page: 2 })).toBe(
      'lat=9.03&lng=38.74&radiusKm=25&availableOnly=true&page=2&size=20',
    )
    expect(buildMedicineSearchQuery({ location: { lat: 200, lng: 38 } })).toBe('size=20')
    expect(buildMedicineSearchQuery({ availableOnly: true })).toBe('size=20')
  })

  it('a refused or missing location resolves to null', async () => {
    expect(await requestLocation(undefined)).toBeNull()
    expect(await requestLocation({ getCurrentPosition: (_ok, err) => err(new Error('denied')) })).toBeNull()
  })
})
