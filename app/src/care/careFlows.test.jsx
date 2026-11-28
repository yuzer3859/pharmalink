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
import { CareContext, buildProviderQuery, buildServiceQuery, createCareService, mapLink } from './careService'
import { DoctorsContext, createDoctorsService } from '../doctors/doctorsService'
import { fakeFetch, fail, ok } from '../test/fakeBackend'
import { categoryTree } from '../test/catalogFixtures'

beforeAll(() => {
  MotionGlobalConfig.skipAnimations = true
})

const HOSPITAL = '11111111-1111-4111-8111-111111111111'
const LAB = '22222222-2222-4222-8222-222222222222'
const CBC = '33333333-3333-4333-8333-333333333333'
const PROVIDERS = 'GET /search/providers'
const SERVICES = 'GET /search/services'

const providerHit = (over = {}) => ({
  providerId: HOSPITAL,
  type: 'HOSPITAL',
  name: 'Tikur Anbessa Hospital',
  nameAm: 'ጥቁር አንበሳ ሆስፒታል',
  description: null,
  city: 'Addis Ababa',
  emergency: 'H24_7',
  specialties: ['Cardiology'],
  serviceTypes: [],
  ratingAvg: null,
  distanceMeters: null,
  ...over,
})
const serviceHit = (over = {}) => ({
  serviceId: CBC,
  name: 'Complete blood count',
  serviceType: 'LAB_TEST',
  code: 'CBC',
  price: 25000,
  currency: 'ETB',
  durationMinutes: 15,
  preparationInstructions: 'No fasting needed.',
  provider: { providerId: LAB, name: 'Bethel Medical Laboratory', type: 'LAB' },
  locationName: 'Bole branch',
  city: 'Addis Ababa',
  distanceMeters: null,
  ...over,
})
const page = (items, extra = {}) => ({ items, total: items.length, page: 1, size: 20, match: 'EXACT', didYouMean: null, ...extra })

function renderApp(path, routes) {
  const backend = fakeFetch({ 'GET /catalog/categories': ok(categoryTree()), ...routes })
  const api = createApiClient({ baseUrl: 'http://api.test', fetcher: backend.fetcher })
  render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider service={createAuthService({ api, storage: sessionStorage })}>
        <CatalogContext.Provider value={createCatalogService({ api })}>
          <SearchContext.Provider value={createSearchService({ api })}>
            <CareContext.Provider value={createCareService({ api })}>
              <DoctorsContext.Provider value={createDoctorsService({ api })}>
                <App />
              </DoctorsContext.Provider>
            </CareContext.Provider>
          </SearchContext.Provider>
        </CatalogContext.Provider>
      </AuthProvider>
    </MemoryRouter>,
  )
  return backend
}

const params = (call) => Object.fromEntries(new URL(call.url).searchParams)

describe('hospitals, clinics and labs (Work 165)', () => {
  it('lists providers from the real search, with type, emergency and city', async () => {
    const { callsTo } = renderApp('/care', { [PROVIDERS]: ok(page([providerHit()])) })
    expect(await screen.findByText('Tikur Anbessa Hospital')).toBeTruthy()
    expect(screen.getByText('ጥቁር አንበሳ ሆስፒታል')).toBeTruthy()
    expect(screen.getByText('24/7 emergency')).toBeTruthy()
    expect(screen.getByRole('link', { name: /Tikur Anbessa Hospital/ }).getAttribute('href')).toBe(`/care/${HOSPITAL}`)
    expect(params(callsTo(PROVIDERS)[0])).toEqual({ size: '20' })

    fireEvent.click(screen.getByRole('button', { name: 'Labs' }))
    await waitFor(() => expect(params(callsTo(PROVIDERS).at(-1))).toMatchObject({ type: 'LAB' }))
    fireEvent.click(screen.getByRole('checkbox', { name: /Emergency service only/ }))
    await waitFor(() => expect(params(callsTo(PROVIDERS).at(-1))).toMatchObject({ type: 'LAB', emergency: 'true' }))
  })

  it('says when results are for a close spelling, and when nothing matches', async () => {
    renderApp('/care?q=cardiolgy', { [PROVIDERS]: ok(page([providerHit()], { match: 'SIMILAR', didYouMean: 'Tikur Anbessa Hospital' })) })
    expect(await screen.findByText(/Showing results for “Tikur Anbessa Hospital”/)).toBeTruthy()
  })

  it('offers a retry when search fails, and an empty state', async () => {
    renderApp('/care?q=nothing', { [PROVIDERS]: [fail(503, 'SEARCH_BACKEND_UNAVAILABLE'), ok(page([]))] })
    fireEvent.click(await screen.findByRole('button', { name: /Try again/ }))
    expect(await screen.findByText('No hospitals, clinics or labs match “nothing”.')).toBeTruthy()
  })

  it('shows a provider’s page: locations with hours and a map link, departments and services', async () => {
    renderApp(`/care/${LAB}`, {
      [`GET /providers/${LAB}`]: ok({
        providerId: LAB,
        type: 'LAB',
        displayName: 'Bethel Medical Laboratory',
        nameEn: 'Bethel Medical Laboratory',
        nameAm: null,
        description: 'Accredited laboratory.',
        website: 'javascript:alert(1)',
        contactPhone: '+251 11 661 0000',
        contactEmail: null,
        ratingAvg: 0,
        ratingCount: 0,
        locations: [
          {
            locationId: 'loc-1',
            name: 'Bole branch',
            city: 'Addis Ababa',
            subcity: 'Bole',
            addressLine: 'Africa Avenue',
            lat: 9.0108,
            lng: 38.7613,
            phone: null,
            emergencyAvailability: 'NONE',
            isPrimary: true,
            hours: [{ weekday: 1, openTime: '08:00', closeTime: '17:30', isClosed: false }, { weekday: 0, openTime: null, closeTime: null, isClosed: true }],
            facilities: ['Parking'],
          },
        ],
        departments: [{ departmentId: 'd-1', name: 'Microbiology', specialty: null, description: null, contactPhone: null }],
        services: [{ serviceId: CBC, type: 'LAB_TEST', name: 'Complete blood count', code: 'CBC', price: 25000, currency: 'ETB', durationMinutes: 15, preparationInstructions: 'No fasting needed.', locationId: 'loc-1' }],
      }),
    })
    expect(await screen.findByRole('heading', { name: 'Bethel Medical Laboratory' })).toBeTruthy()
    expect(screen.getByText('Bole branch')).toBeTruthy()
    expect(screen.getByText(/08:00–17:30/)).toBeTruthy()
    expect(screen.getByText('Parking')).toBeTruthy()
    expect(screen.getByText('Microbiology')).toBeTruthy()
    expect(screen.getByText('Complete blood count')).toBeTruthy()
    expect(screen.getByText('No fasting needed.')).toBeTruthy()
    expect(screen.getByRole('link', { name: /Open in map/ }).getAttribute('href')).toBe(mapLink(9.0108, 38.7613))
    expect(screen.getByRole('link', { name: /\+251 11 661 0000/ }).getAttribute('href')).toBe('tel:+251116610000')
    // A website that is not http(s) is never linked.
    expect(screen.queryByRole('link', { name: 'Website' })).toBeNull()
  })

  it('a provider that is not shown to customers says so', async () => {
    renderApp(`/care/${HOSPITAL}`, { [`GET /providers/${HOSPITAL}`]: fail(404, 'PROVIDER_NOT_FOUND') })
    expect(await screen.findByText("This provider isn't available on PharmaLink right now.")).toBeTruthy()
  })
})

describe('lab tests and imaging (Work 165)', () => {
  it('compares tests cheapest first, each with its provider and preparation', async () => {
    const { callsTo } = renderApp('/diagnostics', { [SERVICES]: ok(page([serviceHit(), serviceHit({ serviceId: '44444444-4444-4444-8444-444444444444', price: 30000, provider: { providerId: HOSPITAL, name: 'Hawassa Lab', type: 'LAB' } })])) })
    expect(await screen.findAllByText('Complete blood count')).toHaveLength(2)
    expect(params(callsTo(SERVICES)[0])).toEqual({ sort: 'price', size: '20' })
    expect(screen.getByRole('link', { name: 'Bethel Medical Laboratory' }).getAttribute('href')).toBe(`/care/${LAB}`)
    expect(screen.getAllByText(/Before the test: No fasting needed./)).toHaveLength(2)

    fireEvent.click(screen.getByRole('button', { name: 'Imaging' }))
    await waitFor(() => expect(params(callsTo(SERVICES).at(-1))).toMatchObject({ serviceType: 'IMAGING', sort: 'price' }))
  })

  it('sends only validated parameters', () => {
    expect(buildProviderQuery({ q: '  cardio ', type: 'PHARMACY', emergency: 'yes', page: 0 })).toBe('q=cardio&size=20')
    expect(buildProviderQuery({ type: 'LAB', emergency: true, location: { lat: 9.03, lng: 38.74 }, page: 2 })).toBe('type=LAB&emergency=true&lat=9.03&lng=38.74&radiusKm=25&page=2&size=20')
    // Distance needs a location; without one the sort is dropped.
    expect(buildServiceQuery({ sort: 'distance' })).toBe('size=20')
    expect(buildServiceQuery({ serviceType: 'SURGERY', providerId: 'nope', sort: 'price' })).toBe('sort=price&size=20')
    expect(buildServiceQuery({ location: { lat: 9, lng: 38 }, sort: 'distance' })).toBe('lat=9&lng=38&radiusKm=25&sort=distance&size=20')
    expect(mapLink(200, 1)).toBeNull()
  })
})
