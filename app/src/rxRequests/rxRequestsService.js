import { ApiError } from '../auth/apiClient'

// Work 138 (owner decision 2026-11-17): the customer's prescription requests (Works 134–136). The
// customer sends an uploaded prescription with a delivery address and its date; nearby pharmacies
// are offered it; the first to accept sends its medicines and price; the customer confirms the
// quote into an order (paying now or on delivery) or declines it.

const isRecord = (value) => typeof value === 'object' && value !== null
const malformed = () => new ApiError(0, 'MALFORMED_RESPONSE', 'The server sent an unexpected response.')

/** Requests a customer can still withdraw. */
export const LIVE_STATUSES = ['OPEN', 'CLAIMED']

/** Requests that no longer move. */
export const ENDED_STATUSES = ['CONFIRMED', 'CANCELLED', 'EXPIRED', 'NO_PHARMACY']

/** Today as `YYYY-MM-DD`, in the customer's own time zone. */
export function todayIso(now = new Date()) {
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000)
  return local.toISOString().slice(0, 10)
}

/** A plain sentence and tone for where the request is. */
export function requestStage(r) {
  switch (r?.status) {
    case 'OPEN':
      return { title: 'Looking for a pharmacy', tone: 'info', body: r.stillConsidering > 0 ? `Sent to ${r.offeredTo} pharmacies nearby; ${r.stillConsidering} still considering it.` : 'Sent to pharmacies nearby.' }
    case 'CLAIMED':
      return { title: `${r.pharmacy?.name || 'A pharmacy'} accepted it`, tone: 'brand', body: 'The pharmacist is checking your prescription and will send you the medicines and price.' }
    case 'QUOTED':
      return { title: 'Your medicines and price are ready', tone: 'warning', body: 'Check them and confirm to place your order.' }
    case 'CONFIRMED':
      return { title: 'Confirmed', tone: 'success', body: 'It is an order now.' }
    case 'CANCELLED':
      return { title: 'Cancelled', tone: 'neutral', body: r.closedReason === 'quote-declined-by-customer' ? 'You declined the pharmacy’s quote.' : 'You cancelled this request.' }
    case 'EXPIRED':
      return {
        title: 'Expired',
        tone: 'neutral',
        body: r.closedReason === 'quote-not-answered-in-time' ? 'The quote was not confirmed in time.' : 'No pharmacy accepted it in time.',
      }
    case 'NO_PHARMACY':
      return { title: 'No pharmacy available', tone: 'danger', body: 'No pharmacy nearby can fill it right now.' }
    default:
      return { title: 'Prescription request', tone: 'neutral', body: '' }
  }
}

export function createRxRequestsService({ request }) {
  const path = (id, action) => `/rx-requests/${encodeURIComponent(id)}${action ? `/${action}` : ''}`
  return {
    async send({ prescriptionId, addressId, prescriptionIssueDate, note }) {
      const body = { prescriptionId, addressId, prescriptionIssueDate }
      if (note?.trim()) body.note = note.trim()
      const data = await request('POST', '/rx-requests', body)
      if (!isRecord(data) || typeof data.id !== 'string') throw malformed()
      return data
    },
    async list() {
      const data = await request('GET', '/rx-requests?page=1&size=50')
      if (!isRecord(data) || !Array.isArray(data.items)) throw malformed()
      return data.items
    },
    async get(id) {
      return request('GET', path(id))
    },
    async cancel(id) {
      return request('POST', path(id, 'cancel'))
    },
    /** `method` 'COD' sends no payment; any other pays now through the gateway (opaque `token` only). */
    async confirm(id, { method, token } = {}) {
      const body = method && method !== 'COD' ? { payment: { method, ...(token ? { token } : {}) } } : {}
      const data = await request('POST', path(id, 'confirm'), body)
      if (!isRecord(data) || typeof data.orderId !== 'string') throw malformed()
      return data
    },
    async declineQuote(id) {
      return request('POST', path(id, 'decline-quote'))
    },
  }
}
