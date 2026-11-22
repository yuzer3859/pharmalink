import { ApiError } from '../auth/apiClient'
import { t } from '../auth/strings'

// Work 138 (owner decision 2026-11-17): the customer's prescription requests (Works 134–136). The
// customer sends an uploaded prescription with a delivery address and its date; nearby pharmacies
// are offered it; the first to accept sends its medicines and price; the customer confirms the
// quote into an order (paying now or on delivery) or declines it.

const isRecord = (value) => typeof value === 'object' && value !== null
const malformed = () => new ApiError(0, 'MALFORMED_RESPONSE', t('common.unexpected'))

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
      return {
        title: t('req.stage.open'),
        tone: 'info',
        body: r.stillConsidering > 0 ? t('req.stage.open.body', { offered: r.offeredTo, considering: r.stillConsidering }) : t('req.stage.open.sent'),
      }
    case 'CLAIMED':
      return { title: t('req.stage.claimed', { name: r.pharmacy?.name || t('req.stage.claimed.noname') }), tone: 'brand', body: t('req.stage.claimed.body') }
    case 'QUOTED':
      return { title: t('req.stage.quoted'), tone: 'warning', body: t('req.stage.quoted.body') }
    case 'CONFIRMED':
      return { title: t('req.stage.confirmed'), tone: 'success', body: t('req.stage.confirmed.body') }
    case 'CANCELLED':
      return {
        title: t('orders.status.CANCELLED'),
        tone: 'neutral',
        body: t(r.closedReason === 'quote-declined-by-customer' ? 'req.stage.cancelled.declined' : 'req.stage.cancelled.byYou'),
      }
    case 'EXPIRED':
      return {
        title: t('rx.status.EXPIRED'),
        tone: 'neutral',
        body: t(r.closedReason === 'quote-not-answered-in-time' ? 'req.stage.expired.quote' : 'req.stage.expired.open'),
      }
    case 'NO_PHARMACY':
      return { title: t('req.stage.none'), tone: 'danger', body: t('req.stage.none.body') }
    default:
      return { title: t('req.title'), tone: 'neutral', body: '' }
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
