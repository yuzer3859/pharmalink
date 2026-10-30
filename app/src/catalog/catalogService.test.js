import { describe, expect, it } from 'vitest'
import { createApiClient } from '../auth/apiClient'
import { buildProductQuery, createCatalogService } from './catalogService'
import { flattenCategories, summarizeAvailability } from './format'
import { formatMinorUnits } from '../lib/utils'
import { fail, fakeFetch, ok } from '../test/fakeBackend'
import { CATEGORY_ID, CHILD_CATEGORY_ID, HEALTH_CATEGORY_ID, PRODUCT_ID, categoryTree, detail, listing, page, summary } from '../test/catalogFixtures'

function setup(routes) {
  const backend = fakeFetch(routes)
  const catalog = createCatalogService({ api: createApiClient({ baseUrl: 'http://api.test', fetcher: backend.fetcher }) })
  return { ...backend, catalog }
}
const query = (call) => Object.fromEntries(new URL(call.url).searchParams)

describe('product query string', () => {
  it('sends only supported, valid parameters', () => {
    expect(buildProductQuery({})).toBe('size=20')
    expect(new URLSearchParams(buildProductQuery({
      q: '  amox ', type: 'MEDICINE', rx: 'OTC', categoryId: CATEGORY_ID, sort: 'name_asc', page: 3, size: 10,
    })).toString()).toBe(`q=amox&type=MEDICINE&rx=OTC&categoryId=${CATEGORY_ID}&sort=name_asc&page=3&size=10`)
  })

  it('drops unsupported values instead of sending them', () => {
    const params = new URLSearchParams(buildProductQuery({
      q: '', type: 'DEVICE', rx: 'maybe', categoryId: 'not-a-uuid', sort: 'price', page: 0, size: 500, inStock: true, lat: 9,
    }))
    expect([...params.keys()]).toEqual(['size'])
    expect(params.get('size')).toBe('20')
    expect(buildProductQuery({ sort: 'relevance', page: 1 })).toBe('size=20')
  })
})

describe('catalog service', () => {
  it('searches the public product list without a token and unwraps { items, meta }', async () => {
    const { catalog, calls } = setup({ 'GET /catalog/products': ok(page([summary()], { total: 41, page: 2 })) })
    const result = await catalog.searchProducts({ q: 'amox', type: 'MEDICINE', rx: 'RX', page: 2 })
    expect(result.items[0].brandName).toBe('Amoxil')
    expect(result.meta).toEqual({ page: 2, size: 20, total: 41 })
    expect(query(calls[0])).toEqual({ q: 'amox', type: 'MEDICINE', rx: 'RX', page: '2', size: '20' })
    expect(calls[0].headers.Authorization).toBeUndefined()
  })

  it('rejects a malformed list response rather than treating it as empty', async () => {
    const { catalog } = setup({ 'GET /catalog/products': [ok({ items: 'nope' }), ok([summary()]), ok(page([{ name: 'x' }]))] })
    for (let i = 0; i < 3; i += 1) {
      await expect(catalog.searchProducts({})).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
    }
  })

  it('passes backend errors and network failures through distinctly', async () => {
    const { catalog } = setup({ 'GET /catalog/products': [fail(400, 'VALIDATION_ERROR', 'bad'), 'NETWORK'] })
    await expect(catalog.searchProducts({})).rejects.toMatchObject({ status: 400, code: 'VALIDATION_ERROR' })
    await expect(catalog.searchProducts({})).rejects.toMatchObject({ code: 'NETWORK_ERROR' })
  })

  it('reports a cancelled request as ABORTED, not as a network failure', async () => {
    const controller = new AbortController()
    const fetcher = async (url, init) => {
      init.signal.throwIfAborted()
      return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))))
    }
    const abortable = createCatalogService({ api: createApiClient({ baseUrl: 'http://api.test', fetcher }) })
    const pending = abortable.searchProducts({}, { signal: controller.signal })
    controller.abort()
    await expect(pending).rejects.toMatchObject({ code: 'ABORTED' })
  })

  it('loads the category tree', async () => {
    const { catalog, calls } = setup({ 'GET /catalog/categories': ok(categoryTree()) })
    const tree = await catalog.getCategoryTree()
    expect(tree[0].children[0].id).toBe(CHILD_CATEGORY_ID)
    expect(calls[0].url).toBe('http://api.test/catalog/categories')
  })

  it('loads a product by id, and answers not-found for a malformed id without a request', async () => {
    const { catalog, calls } = setup({ 'GET /catalog/products/11111111-1111-4111-8111-111111111111': ok(detail()) })
    await expect(catalog.getProduct(PRODUCT_ID)).resolves.toMatchObject({ id: PRODUCT_ID, price: 25000 })
    await expect(catalog.getProduct('../admin')).rejects.toMatchObject({ status: 404 })
    expect(calls).toHaveLength(1)
  })

  it('requests availability with a limit and no location, and validates listings', async () => {
    const { catalog, calls } = setup({
      [`GET /availability/product/${PRODUCT_ID}`]: [ok([listing()]), ok([{ ...listing(), price: 12.5 }]), ok({})],
    })
    await expect(catalog.getAvailability(PRODUCT_ID)).resolves.toEqual([listing()])
    expect(query(calls[0])).toEqual({ limit: '100' })
    await expect(catalog.getAvailability(PRODUCT_ID)).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
    await expect(catalog.getAvailability(PRODUCT_ID)).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
  })
})

describe('formatting', () => {
  it('formats integer minor units without floating point and refuses non-integers', () => {
    expect(formatMinorUnits(31050, 'ETB')).toBe('ETB 310.50')
    expect(formatMinorUnits(5, 'ETB')).toBe('ETB 0.05')
    expect(formatMinorUnits(123456789, 'ETB')).toBe('ETB 1,234,567.89')
    expect(formatMinorUnits(12.5, 'ETB')).toBeNull()
    expect(formatMinorUnits(100, 'nope')).toBeNull()
  })

  it('summarises availability as a count and a per-currency price range', () => {
    expect(summarizeAvailability([])).toEqual({ count: 0, atLeast: false, ranges: [] })
    const s = summarizeAvailability([listing({ price: 31050 }), listing({ price: 28000 }), listing({ price: 29900 })])
    expect(s.count).toBe(3)
    expect(s.ranges).toEqual([{ currency: 'ETB', min: 28000, max: 31050, label: 'ETB 280.00 – ETB 310.50' }])
    expect(summarizeAvailability(Array.from({ length: 100 }, () => listing())).atLeast).toBe(true)
  })

  it('flattens active categories that apply to the chosen product type', () => {
    const tree = categoryTree()
    tree.push({ id: '99999999-9999-4999-8999-999999999999', parentId: null, slug: 'off', nameEn: 'Hidden', appliesTo: 'BOTH', sortOrder: 3, isActive: false, children: [] })
    expect(flattenCategories(tree, '')).toEqual([
      { id: CATEGORY_ID, label: 'Antibiotics', depth: 0 },
      { id: CHILD_CATEGORY_ID, label: 'Penicillins', depth: 1 },
      { id: HEALTH_CATEGORY_ID, label: 'Personal care', depth: 0 },
    ])
    expect(flattenCategories(tree, 'HEALTH_PRODUCT').map((c) => c.id)).toEqual([HEALTH_CATEGORY_ID])
  })
})
