import { createContext, useContext } from 'react'
import { API_BASE_URL } from '../config/env'
import { ApiError, createApiClient } from '../auth/apiClient'
import { isUuid } from '../catalog/catalogService'

// Read-only client for Module 14's public search (Work 98). No token is sent. Only the query
// parameters the backend validates are ever sent; anything else is dropped.

export const SEARCH_PAGE_SIZE = 20
export const DEFAULT_RADIUS_KM = 25

const isRecord = (value) => typeof value === 'object' && value !== null
const malformed = () => new ApiError(0, 'MALFORMED_RESPONSE', 'The server sent an unexpected response.')
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

function readOffer(item) {
  if (!isRecord(item) || !Number.isSafeInteger(item.price) || typeof item.pharmacyName !== 'string') throw malformed()
  return item
}

export function createSearchService({ api }) {
  return {
    async searchMedicines(filters, { signal } = {}) {
      const data = await api.get(`/search/medicines?${buildMedicineSearchQuery(filters)}`, { signal })
      if (!isRecord(data) || !Array.isArray(data.items) || !Number.isInteger(data.total)) throw malformed()
      return { items: data.items.map(readHit), total: data.total, page: data.page, size: data.size }
    },

    /** Where a product can be bought now; nearest first when a location is given. */
    async whereToBuy(productId, location, { signal } = {}) {
      if (!isUuid(productId)) throw new ApiError(404, 'NOT_FOUND', 'Resource not found')
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
