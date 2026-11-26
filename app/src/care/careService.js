import { createContext, useContext } from 'react'
import { API_BASE_URL } from '../config/env'
import { ApiError, createApiClient } from '../auth/apiClient'
import { t } from '../auth/strings'
import { isUuid } from '../catalog/catalogService'
import { DEFAULT_RADIUS_KM } from '../search/searchService'

// Work 165: read-only client for hospitals, clinics, diagnostic centres and labs (Module 09) and
// the tests they offer, through Module 14's public search (Work 162). No token is sent. Only the
// query parameters the backend validates are ever sent.

export const CARE_PAGE_SIZE = 20
export const PROVIDER_TYPES = ['HOSPITAL', 'CLINIC', 'DIAGNOSTIC_CENTER', 'LAB']
export const SERVICE_TYPES = ['LAB_TEST', 'IMAGING', 'SCREENING_PACKAGE']

const isRecord = (value) => typeof value === 'object' && value !== null
const malformed = () => new ApiError(0, 'MALFORMED_RESPONSE', t('common.unexpected'))
const isCoordinate = (value, limit) => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= limit

function setLocation(params, location) {
  if (location && isCoordinate(location.lat, 90) && isCoordinate(location.lng, 180)) {
    params.set('lat', String(location.lat))
    params.set('lng', String(location.lng))
    params.set('radiusKm', String(location.radiusKm ?? DEFAULT_RADIUS_KM))
  }
}

function setPage(params, page) {
  const n = Number(page)
  if (Number.isInteger(n) && n > 1) params.set('page', String(n))
  params.set('size', String(CARE_PAGE_SIZE))
}

const text = (q) => (typeof q === 'string' ? q.trim().slice(0, 120) : '')

/** `GET /search/providers` query string, from allowlisted, validated values only. */
export function buildProviderQuery({ q, type, emergency, location, page } = {}) {
  const params = new URLSearchParams()
  if (text(q)) params.set('q', text(q))
  if (PROVIDER_TYPES.includes(type)) params.set('type', type)
  if (emergency === true) params.set('emergency', 'true')
  setLocation(params, location)
  setPage(params, page)
  return params.toString()
}

/** `GET /search/services` query string. Sorting by distance needs a location; otherwise price. */
export function buildServiceQuery({ q, serviceType, providerId, location, sort, page } = {}) {
  const params = new URLSearchParams()
  if (text(q)) params.set('q', text(q))
  if (SERVICE_TYPES.includes(serviceType)) params.set('serviceType', serviceType)
  if (isUuid(providerId)) params.set('providerId', providerId)
  setLocation(params, location)
  if (sort === 'price') params.set('sort', 'price')
  else if (sort === 'distance' && params.has('lat')) params.set('sort', 'distance')
  setPage(params, page)
  return params.toString()
}

function readPage(data, readItem) {
  if (!isRecord(data) || !Array.isArray(data.items) || !Number.isInteger(data.total)) throw malformed()
  return {
    items: data.items.map(readItem),
    total: data.total,
    match: data.match === 'SIMILAR' || data.match === 'EXACT' ? data.match : null,
    didYouMean: data.match === 'SIMILAR' && typeof data.didYouMean === 'string' ? data.didYouMean : null,
  }
}

function readProvider(item) {
  if (!isRecord(item) || !isUuid(item.providerId) || typeof item.name !== 'string') throw malformed()
  return {
    ...item,
    specialties: Array.isArray(item.specialties) ? item.specialties : [],
    serviceTypes: Array.isArray(item.serviceTypes) ? item.serviceTypes : [],
  }
}

function readService(item) {
  if (!isRecord(item) || !isUuid(item.serviceId) || typeof item.name !== 'string' || !isRecord(item.provider)) throw malformed()
  if (item.price !== null && !Number.isSafeInteger(item.price)) throw malformed()
  return item
}

export function createCareService({ api }) {
  return {
    async searchProviders(filters, { signal } = {}) {
      return readPage(await api.get(`/search/providers?${buildProviderQuery(filters)}`, { signal }), readProvider)
    },

    async searchServices(filters, { signal } = {}) {
      return readPage(await api.get(`/search/services?${buildServiceQuery(filters)}`, { signal }), readService)
    },

    /** `GET /providers/:id`: a provider's public page; 404 when it is not shown to customers. */
    async provider(providerId, { signal } = {}) {
      if (!isUuid(providerId)) throw new ApiError(404, 'NOT_FOUND', t('common.notFound'))
      const data = await api.get(`/providers/${providerId}`, { signal })
      if (!isRecord(data) || !isUuid(data.providerId) || !Array.isArray(data.locations) || !Array.isArray(data.services)) throw malformed()
      return { ...data, departments: Array.isArray(data.departments) ? data.departments : [] }
    },
  }
}

let defaultService
export function getDefaultCareService() {
  if (!defaultService) defaultService = createCareService({ api: createApiClient({ baseUrl: API_BASE_URL }) })
  return defaultService
}

export const CareContext = createContext(null)

/** The care service; tests provide their own through <CareContext.Provider>. */
export function useCare() {
  return useContext(CareContext) ?? getDefaultCareService()
}

/** A map link to a location; opens the map in a new tab. */
export function mapLink(lat, lng) {
  if (!isCoordinate(lat, 90) || !isCoordinate(lng, 180)) return null
  return `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=17/${lat}/${lng}`
}

/** "850 m" or "3.4 km". */
export function distanceLabel(meters) {
  if (meters == null) return null
  return meters < 1000 ? `${meters} m` : `${(meters / 1000).toFixed(1)} km`
}
