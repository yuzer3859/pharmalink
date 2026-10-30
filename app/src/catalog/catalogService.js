import { createContext, useContext } from 'react'
import { API_BASE_URL } from '../config/env'
import { ApiError, createApiClient } from '../auth/apiClient'

// Read-only client for the public Catalog (module 03) and Inventory availability (module 04)
// endpoints. Every route here is `@Public()` on the backend, so no token is sent. Only the query
// parameters the backend validates are ever sent; anything else is dropped.

export const PRODUCT_TYPES = ['MEDICINE', 'HEALTH_PRODUCT']
export const RX_CLASSES = ['RX', 'OTC']
export const SORTS = ['relevance', 'name_asc', 'newest']
export const PAGE_SIZE = 20
/** The availability endpoint's maximum `limit`; listing counts are "at least" this when reached. */
export const AVAILABILITY_LIMIT = 100

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const isUuid = (value) => typeof value === 'string' && UUID.test(value)

const isRecord = (value) => typeof value === 'object' && value !== null
const malformed = () => new ApiError(0, 'MALFORMED_RESPONSE', 'The server sent an unexpected response.')

/** Builds the `GET /catalog/products` query string from allowlisted, validated values only. */
export function buildProductQuery({ q, type, rx, categoryId, sort, page, size } = {}) {
  const params = new URLSearchParams()
  const text = typeof q === 'string' ? q.trim().slice(0, 100) : ''
  if (text) params.set('q', text)
  if (PRODUCT_TYPES.includes(type)) params.set('type', type)
  if (RX_CLASSES.includes(rx)) params.set('rx', rx)
  if (isUuid(categoryId)) params.set('categoryId', categoryId)
  if (SORTS.includes(sort) && sort !== 'relevance') params.set('sort', sort)
  const pageNumber = Number(page)
  if (Number.isInteger(pageNumber) && pageNumber > 1) params.set('page', String(pageNumber))
  const pageSize = Number(size)
  params.set('size', String(Number.isInteger(pageSize) && pageSize >= 1 && pageSize <= 50 ? pageSize : PAGE_SIZE))
  return params.toString()
}

function readSummary(item) {
  if (!isRecord(item) || !isUuid(item.id) || typeof item.type !== 'string') throw malformed()
  return item
}

function readCategoryNode(node) {
  if (!isRecord(node) || !isUuid(node.id) || typeof node.slug !== 'string') throw malformed()
  return { ...node, children: Array.isArray(node.children) ? node.children.map(readCategoryNode) : [] }
}

function readAvailabilityItem(item) {
  if (!isRecord(item) || !Number.isSafeInteger(item.price) || typeof item.currency !== 'string' ||
      !Number.isFinite(item.sellable)) {
    throw malformed()
  }
  return item
}

export function createCatalogService({ api }) {
  return {
    async searchProducts(filters, { signal } = {}) {
      const data = await api.get(`/catalog/products?${buildProductQuery(filters)}`, { signal })
      if (!isRecord(data) || !Array.isArray(data.items) || !isRecord(data.meta) ||
          !Number.isInteger(data.meta.total) || !Number.isInteger(data.meta.page) || !Number.isInteger(data.meta.size)) {
        throw malformed()
      }
      return { items: data.items.map(readSummary), meta: data.meta }
    },

    async getCategoryTree({ signal } = {}) {
      const data = await api.get('/catalog/categories', { signal })
      if (!Array.isArray(data)) throw malformed()
      return data.map(readCategoryNode)
    },

    async getProduct(id, { signal } = {}) {
      // A malformed id can't name a product; answer "not found" without asking the server.
      if (!isUuid(id)) throw new ApiError(404, 'NOT_FOUND', 'Resource not found')
      const data = await api.get(`/catalog/products/${id}`, { signal })
      if (!isRecord(data) || data.id !== id || typeof data.type !== 'string' || typeof data.status !== 'string') {
        throw malformed()
      }
      return { ...data, categories: Array.isArray(data.categories) ? data.categories : [] }
    },

    /** No `lat`/`lng` are ever sent: the app has no customer location yet (Work 64). */
    async getAvailability(productId, { signal } = {}) {
      if (!isUuid(productId)) throw new ApiError(404, 'NOT_FOUND', 'Resource not found')
      const data = await api.get(`/availability/product/${productId}?limit=${AVAILABILITY_LIMIT}`, { signal })
      if (!Array.isArray(data)) throw malformed()
      return data.map(readAvailabilityItem)
    },
  }
}

let defaultService
export function getDefaultCatalogService() {
  if (!defaultService) defaultService = createCatalogService({ api: createApiClient({ baseUrl: API_BASE_URL }) })
  return defaultService
}

export const CatalogContext = createContext(null)

/** The catalog service; tests provide their own through <CatalogContext.Provider>. */
export function useCatalog() {
  return useContext(CatalogContext) ?? getDefaultCatalogService()
}
