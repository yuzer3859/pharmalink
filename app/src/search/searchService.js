import { createContext, useContext } from 'react'
import { API_BASE_URL } from '../config/env'
import { ApiError, createApiClient } from '../auth/apiClient'
import { t } from '../auth/strings'
import { isUuid } from '../catalog/catalogService'

// Read-only client for Module 14's public search (Work 98). No token is sent. Only the query
// parameters the backend validates are ever sent; anything else is dropped.

export const SEARCH_PAGE_SIZE = 20
export const DEFAULT_RADIUS_KM = 25
export const SUGGEST_MIN_LENGTH = 2
export const SUGGEST_MAX_LENGTH = 60
export const SUGGEST_LIMIT = 8
export const TRENDING_LIMIT = 8

const isRecord = (value) => typeof value === 'object' && value !== null
const malformed = () => new ApiError(0, 'MALFORMED_RESPONSE', t('common.unexpected'))
const isCoordinate = (value, limit) => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= limit

/** `GET /search/medicines` query string, from allowlisted, validated values only. */
export function buildMedicineSearchQuery({ q, rx, categoryId, location, availableOnly, page, size } = {}) {
  const params = new URLSearchParams()
  const text = typeof q === 'string' ? q.trim().slice(0, 120) : ''
  if (text) params.set('q', text)
  if (rx === 'RX' || rx === 'OTC') params.set('rx', rx)
  if (isUuid(categoryId)) params.set('categoryId', categoryId)
  if (location && isCoordinate(location.lat, 90) && isCoordinate(location.lng, 180)) {
    params.set('lat', String(location.lat))
    params.set('lng', String(location.lng))
    params.set('radiusKm', String(location.radiusKm ?? DEFAULT_RADIUS_KM))
    if (availableOnly) params.set('availableOnly', 'true')
  }
  const pageNumber = Number(page)
  if (Number.isInteger(pageNumber) && pageNumber > 1) params.set('page', String(pageNumber))
  const pageSize = Number(size)
  params.set('size', String(Number.isInteger(pageSize) && pageSize >= 1 && pageSize <= 50 ? pageSize : SEARCH_PAGE_SIZE))
  return params.toString()
}

function readHit(item) {
  if (!isRecord(item) || !isUuid(item.productId) || !isRecord(item.availability) ||
      !Number.isInteger(item.availability.pharmacyCount)) {
    throw malformed()
  }
  return { ...item, categories: Array.isArray(item.categories) ? item.categories : [] }
}

/** One suggestion, or none when it is malformed or names something the app can't open yet. */
function readSuggestion(item) {
  if (!isRecord(item) || typeof item.text !== 'string' || !item.text.trim()) return []
  if (item.kind === 'QUERY') return [{ kind: 'QUERY', text: item.text, id: null, subtitle: null, imageUrl: null }]
  if (item.kind === 'PRODUCT' && isUuid(item.id)) {
    return [{
      kind: 'PRODUCT',
      text: item.text,
      id: item.id,
      subtitle: typeof item.subtitle === 'string' ? item.subtitle : null,
      imageUrl: typeof item.imageUrl === 'string' ? item.imageUrl : null,
    }]
  }
  return []
}

function readOffer(item) {
  if (!isRecord(item) || !Number.isSafeInteger(item.price) || typeof item.pharmacyName !== 'string') throw malformed()
  return item
}

export function createSearchService({ api }) {
  return {
    async searchMedicines(filters, { signal } = {}) {
      const data = await api.get(`/search/medicines?${buildMedicineSearchQuery(filters)}`, { signal })
      if (!isRecord(data) || !Array.isArray(data.items) || !Number.isInteger(data.total)) throw malformed()
      return {
        items: data.items.map(readHit),
        total: data.total,
        page: data.page,
        size: data.size,
        // Work 159: whether the words matched as typed, or as close spellings ("Showing results for …").
        match: data.match === 'SIMILAR' || data.match === 'EXACT' ? data.match : null,
        didYouMean: data.match === 'SIMILAR' && typeof data.didYouMean === 'string' ? data.didYouMean : null,
      }
    },

    /**
     * Work 159: suggestions while typing (Work 158's `GET /search/suggest`): popular searches and
     * products. Pharmacies are left out until the app has a pharmacy page to open.
     */
    async suggest(text, { signal } = {}) {
      const q = typeof text === 'string' ? text.trim().slice(0, SUGGEST_MAX_LENGTH) : ''
      if (q.length < SUGGEST_MIN_LENGTH) return []
      const params = new URLSearchParams({ q, limit: String(SUGGEST_LIMIT) })
      const data = await api.get(`/search/suggest?${params}`, { signal })
      if (!isRecord(data) || !Array.isArray(data.items)) throw malformed()
      return data.items.flatMap(readSuggestion)
    },

    /** Work 159: this week's most made searches (`GET /search/trending`). */
    async trending({ signal } = {}) {
      const data = await api.get(`/search/trending?limit=${TRENDING_LIMIT}`, { signal })
      if (!isRecord(data) || !Array.isArray(data.items)) throw malformed()
      return data.items.filter((i) => isRecord(i) && typeof i.term === 'string' && i.term.trim()).map((i) => i.term)
    },

    /** Where a product can be bought now; nearest first when a location is given. */
    async whereToBuy(productId, location, { signal } = {}) {
      if (!isUuid(productId)) throw new ApiError(404, 'NOT_FOUND', t('common.notFound'))
      const params = new URLSearchParams({ limit: '20' })
      if (location && isCoordinate(location.lat, 90) && isCoordinate(location.lng, 180)) {
        params.set('lat', String(location.lat))
        params.set('lng', String(location.lng))
        params.set('radiusKm', String(location.radiusKm ?? DEFAULT_RADIUS_KM))
      }
      const data = await api.get(`/search/medicines/${productId}/pharmacies?${params}`, { signal })
      if (!isRecord(data) || !Array.isArray(data.items)) throw malformed()
      return data.items.map(readOffer)
    },
  }
}

let defaultService
export function getDefaultSearchService() {
  if (!defaultService) defaultService = createSearchService({ api: createApiClient({ baseUrl: API_BASE_URL }) })
  return defaultService
}

export const SearchContext = createContext(null)

/** The search service; tests provide their own through <SearchContext.Provider>. */
export function useSearch() {
  return useContext(SearchContext) ?? getDefaultSearchService()
}

/**
 * Asks the browser for the customer's location once, on request. Never stored or sent anywhere
 * except as the search's own `lat`/`lng`. Resolves `null` when refused or unavailable.
 */
export function requestLocation(geolocation = typeof navigator !== 'undefined' ? navigator.geolocation : undefined) {
  return new Promise((resolve) => {
    if (!geolocation) return resolve(null)
    geolocation.getCurrentPosition(
      (pos) => resolve({ lat: Number(pos.coords.latitude.toFixed(5)), lng: Number(pos.coords.longitude.toFixed(5)) }),
      () => resolve(null),
      { enableHighAccuracy: false, timeout: 10_000, maximumAge: 300_000 },
    )
  })
}
