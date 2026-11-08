import { ApiError } from '../auth/apiClient'
import { isUuid } from '../catalog/catalogService'

// Work 100: the customer's cart, checkout and orders over the real API (Modules 02 and 06), signed
// in through `useAuth().request`. Only the fields the backend validates are ever sent.

/** Ways to pay at checkout. COD needs no gateway; the others go through the payment gateway. */
export const PAYMENT_METHODS = [
  { id: 'COD', label: 'Cash on delivery', desc: 'Pay the driver when it arrives' },
  { id: 'TELEBIRR', label: 'Telebirr', desc: 'Pay now' },
  { id: 'CARD', label: 'Card', desc: 'Pay now' },
]

const isRecord = (value) => typeof value === 'object' && value !== null
const malformed = () => new ApiError(0, 'MALFORMED_RESPONSE', 'The server sent an unexpected response.')

/** `null` from the API means the customer has no cart yet: an empty one. */
function readCart(data) {
  if (data === null) return { id: null, items: [], totals: null }
  if (!isRecord(data) || !Array.isArray(data.items)) throw malformed()
  return data
}

/** A fresh idempotency key, so a retried tap never places a second order. */
export function newIdempotencyKey(random = () => (globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`)) {
  return `app-${random()}`
}

export function createOrdersService({ request }) {
  return {
    async cart() {
      return readCart(await request('GET', '/cart'))
    },
    async addToCart(catalogProductId, quantity = 1) {
      if (!isUuid(catalogProductId)) throw new ApiError(404, 'NOT_FOUND', 'Resource not found')
      await request('POST', '/cart/items', { catalogProductId, quantity })
    },
    async setQuantity(itemId, quantity) {
      await request('PATCH', `/cart/items/${encodeURIComponent(itemId)}`, { quantity })
    },
    async removeItem(itemId) {
      await request('DELETE', `/cart/items/${encodeURIComponent(itemId)}`)
    },
    async addresses() {
      const data = await request('GET', '/addresses')
      const list = Array.isArray(data) ? data : Array.isArray(data?.items) ? data.items : null
      if (!list) throw malformed()
      return list
    },
    async addAddress({ recipientName, recipientPhone, city, addressLine, lat, lng }) {
      return request('POST', '/addresses', {
        recipientName,
        recipientPhone,
        city,
        addressLine,
        ...(Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : {}),
      })
    },
    async quote(addressId) {
      const data = await request('POST', '/checkout/quote', { addressId })
      if (!isRecord(data) || !isRecord(data.totals)) throw malformed()
      return data
    },
    /**
     * Places the order. `method` 'COD' sends no payment; any other is a gateway prepayment with an
     * optional opaque `token` (never card data). A decline arrives as ApiError PAYMENT_AUTH_FAILED
     * with `details.orderId` of the order that was cancelled.
     */
    async placeOrder({ addressId, method, token, idempotencyKey }) {
      const body = { addressId, idempotencyKey }
      if (method && method !== 'COD') body.payment = { method, ...(token ? { token } : {}) }
      const data = await request('POST', '/checkout', body)
      if (!isRecord(data) || typeof data.orderId !== 'string') throw malformed()
      return data
    },
    async order(orderId) {
      return request('GET', `/orders/${encodeURIComponent(orderId)}`)
    },
    async orders() {
      const data = await request('GET', '/orders?page=1&size=50')
      if (!isRecord(data) || !Array.isArray(data.items)) throw malformed()
      return data.items
    },
    /** The delivery's tracking snapshot; ApiError NOT_FOUND until a delivery job exists. */
    async tracking(orderId) {
      return request('GET', `/tracking/orders/${encodeURIComponent(orderId)}`)
    },
    async proofOfDelivery(jobId) {
      return request('GET', `/delivery/jobs/${encodeURIComponent(jobId)}/proof-of-delivery`)
    },
    /** A 5-minute link to the delivery photograph or signature. */
    async proofLink(jobId) {
      return request('POST', `/delivery/jobs/${encodeURIComponent(jobId)}/proof-of-delivery/artifact`)
    },
    /** After a decline: puts the cancelled order's products back in the cart. */
    async rebuildCart(lines) {
      for (const line of lines) await this.addToCart(line.catalogProductId, line.quantity)
    },
  }
}
