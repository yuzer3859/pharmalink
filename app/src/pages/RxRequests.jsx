import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft, Check, CreditCard, FileText, MapPin, RefreshCw, Send, Smartphone, Store, Wallet, XCircle } from 'lucide-react'
import { Badge, Button, Card, Input, Skeleton } from '../components/ui'
import { formatMinorUnits } from '../lib/utils'
import { useAuth } from '../auth/AuthContext'
import { AddressForm, PrescriptionAttach, useOrders } from './Checkout'
import { PAYMENT_METHODS } from '../orders/ordersService'
import { ENDED_STATUSES, LIVE_STATUSES, createRxRequestsService, requestStage, todayIso } from '../rxRequests/rxRequestsService'

const METHOD_ICONS = { COD: Wallet, TELEBIRR: Smartphone, CARD: CreditCard }
const PAYMENTS_TEST_MODE = import.meta.env.VITE_PAYMENTS_TEST_MODE === 'true'
/** How often an open request is re-read: pharmacies answer within minutes. */
const POLL_MS = 5000

export function useRxRequests() {
  const { request } = useAuth()
  return useMemo(() => createRxRequestsService({ request }), [request])
}

const money = (amount, currency = 'ETB') => formatMinorUnits(amount, currency) ?? '—'
const when = (iso) => (iso ? new Date(iso).toLocaleString() : '')

/**
 * Work 138 (owner decision 2026-11-17): send a prescription to nearby pharmacies. Upload it, say
 * the date written on it and where to deliver; the first pharmacy to accept sends the medicines and
 * price. For customers who do not know what to pick: with a cart, checkout takes a prescription too.
 */
export function SendRxRequest() {
  const orders = useOrders()
  const service = useRxRequests()
  const navigate = useNavigate()
  const [rx, setRx] = useState({ status: 'none', id: null, name: null, error: null })
  const [issueDate, setIssueDate] = useState(todayIso())
  const [note, setNote] = useState('')
  const [addresses, setAddresses] = useState({ status: 'loading', items: [] })
  const [addressId, setAddressId] = useState('')
  const [adding, setAdding] = useState(false)
  const [sending, setSending] = useState({ busy: false, error: null })

  useEffect(() => {
    orders
      .addresses()
      .then((items) => {
        setAddresses({ status: 'ready', items })
        const preferred = items.find((a) => a.isDefault) ?? items[0]
        if (preferred) setAddressId(preferred.id)
      })
      .catch(() => setAddresses({ status: 'error', items: [] }))
  }, [orders])

  const canSend = rx.status === 'attached' && addressId && /^\d{4}-\d{2}-\d{2}$/.test(issueDate) && !sending.busy

  async function send() {
    setSending({ busy: true, error: null })
    try {
      const created = await service.send({ prescriptionId: rx.id, addressId, prescriptionIssueDate: issueDate, note })
      navigate(`/requests/${created.id}`, { replace: true })
    } catch (error) {
      setSending({ busy: false, error: error?.message || 'The request could not be sent.' })
    }
  }

  return (
    <div className="space-y-6">
      <Link to="/requests" className="inline-flex items-center gap-1 text-caption font-semibold text-brand-600"><ArrowLeft className="h-4 w-4" aria-hidden="true" /> My requests</Link>
      <div>
        <h1 className="font-display text-h1 text-fg">Send a prescription</h1>
        <p className="mt-1 text-body text-muted">Pharmacies near you see it. The first one to accept sends you the medicines and the price, and you decide.</p>
      </div>

      <PrescriptionAttach value={rx} onChange={setRx} intro="Add a clear photo or PDF of your prescription. The pharmacists who see it are shown your name, never your phone or address until you confirm." />

      <Card className="space-y-3 p-4">
        <label className="block">
          <span className="text-body font-semibold text-fg">Date on the prescription</span>
          <Input type="date" aria-label="Date on the prescription" value={issueDate} max={todayIso()} onChange={(e) => setIssueDate(e.target.value)} className="mt-1" />
          <span className="mt-1 block text-caption text-muted">Prescriptions older than 14 days are not accepted. The pharmacist checks the date.</span>
        </label>
        <label className="block">
          <span className="text-body font-semibold text-fg">Note for the pharmacist (optional)</span>
          <Input aria-label="Note for the pharmacist" placeholder="For example: I prefer a generic brand" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} className="mt-1" />
        </label>
      </Card>

      <Card className="space-y-3 p-4">
        <h2 className="flex items-center gap-2 text-h3 text-fg"><MapPin className="h-5 w-5 text-brand-500" aria-hidden="true" /> Deliver to</h2>
        {addresses.items.map((a) => (
          <label key={a.id} className="flex items-start gap-3 rounded-xl border border-border p-3">
            <input type="radio" name="address" value={a.id} checked={addressId === a.id} onChange={() => setAddressId(a.id)} />
            <span className="text-body text-fg">{a.recipientName} · {a.addressLine}, {a.city}</span>
          </label>
        ))}
        {addresses.status === 'ready' && addresses.items.length === 0 && !adding && <p className="text-caption text-muted">Add an address so nearby pharmacies can be found.</p>}
        {adding ? (
          <AddressForm
            orders={orders}
            onSaved={(saved) => {
              setAddresses((s) => ({ ...s, items: [...s.items, saved] }))
              setAddressId(saved.id)
              setAdding(false)
            }}
          />
        ) : (
          <Button variant="ghost" size="sm" onClick={() => setAdding(true)}>Add a new address</Button>
        )}
      </Card>

      {sending.error && <p role="alert" className="text-caption text-danger">{sending.error}</p>}
      <Button size="lg" className="w-full" disabled={!canSend} onClick={send}><Send className="h-4 w-4" aria-hidden="true" /> {sending.busy ? 'Sending…' : 'Send to nearby pharmacies'}</Button>
    </div>
  )
}

function QuoteCard({ r, onConfirmed, onChanged }) {
  const service = useRxRequests()
  const [method, setMethod] = useState('COD')
  const [token, setToken] = useState('')
  const [state, setState] = useState({ busy: false, error: null })
  const q = r.quote

  async function confirm() {
    setState({ busy: true, error: null })
    try {
      const done = await service.confirm(r.id, { method, token: PAYMENTS_TEST_MODE ? token.trim() : undefined })
      onConfirmed(done.orderId)
    } catch (error) {
      setState({ busy: false, error: error?.message || 'The order could not be placed.' })
      onChanged()
    }
  }
  async function decline() {
    setState({ busy: true, error: null })
    try {
      await service.declineQuote(r.id)
      onChanged()
    } catch (error) {
      setState({ busy: false, error: error?.message || 'The quote could not be declined.' })
    }
  }

  return (
    <Card className="space-y-3 p-4" aria-label="Quote">
      <h2 className="flex items-center gap-2 text-h3 text-fg"><Store className="h-5 w-5 text-brand-500" aria-hidden="true" /> {r.pharmacy?.name || 'The pharmacy'} offers</h2>
      <ul className="space-y-1" aria-label="Quoted medicines">
        {q.lines.map((l) => (
          <li key={l.catalogProductId} className="flex justify-between text-body">
            <span className="text-fg">{l.quantity} × {l.name || 'Medicine'}</span>
            <span className="text-muted">{money(l.lineTotal, q.currency)}</span>
          </li>
        ))}
      </ul>
      <dl className="space-y-1 border-t border-border pt-2 text-body">
        <div className="flex justify-between"><dt className="text-muted">Delivery</dt><dd>{money(q.deliveryFee, q.currency)}</dd></div>
        {q.platformFee > 0 && <div className="flex justify-between"><dt className="text-muted">Service fee</dt><dd>{money(q.platformFee, q.currency)}</dd></div>}
        <div className="flex justify-between font-semibold"><dt>Total</dt><dd data-testid="quote-total">{money(q.grandTotal, q.currency)}</dd></div>
      </dl>
      {q.note && <p className="text-caption text-muted">Pharmacist’s note: {q.note}</p>}
      {q.paperRequired ? (
        <p className="rounded-xl bg-warning/10 p-3 text-caption text-fg" role="note">
          <strong>Keep the original paper prescription ready.</strong> These medicines need it: the driver collects it from you first, takes it to the pharmacist, then brings your medicines.
        </p>
      ) : (
        <p className="text-caption text-muted">You keep your paper prescription.</p>
      )}
      {r.quoteExpiresAt && <p className="text-caption text-muted">Confirm by {when(r.quoteExpiresAt)}.</p>}

      <div className="grid gap-2 sm:grid-cols-3" role="radiogroup" aria-label="Payment method">
        {PAYMENT_METHODS.map((m) => {
          const Icon = METHOD_ICONS[m.id]
          return (
            <button
              key={m.id}
              type="button"
              role="radio"
              aria-checked={method === m.id}
              onClick={() => setMethod(m.id)}
              className={`flex items-center gap-3 rounded-xl border p-3 text-left ${method === m.id ? 'border-brand-500 bg-brand-500/5' : 'border-border'}`}
            >
              <Icon className="h-5 w-5 text-brand-500" aria-hidden="true" />
              <span><span className="block text-body font-semibold text-fg">{m.label}</span><span className="text-caption text-muted">{m.desc}</span></span>
            </button>
          )
        })}
      </div>
      {PAYMENTS_TEST_MODE && method !== 'COD' && (
        <Input aria-label="Test gateway token" placeholder="Test token (e.g. test-decline)" value={token} onChange={(e) => setToken(e.target.value)} maxLength={512} />
      )}
      {state.error && <p role="alert" className="text-caption text-danger">{state.error}</p>}
      <div className="flex flex-col gap-2 sm:flex-row">
        <Button className="flex-1" disabled={state.busy} onClick={confirm}><Check className="h-4 w-4" aria-hidden="true" /> {state.busy ? 'Placing your order…' : method === 'COD' ? 'Confirm and place order' : 'Pay and place order'}</Button>
        <Button variant="ghost" disabled={state.busy} onClick={decline}><XCircle className="h-4 w-4" aria-hidden="true" /> Decline</Button>
      </div>
    </Card>
  )
}

/** Work 138: one request, re-read every few seconds while a pharmacy may still answer. */
export function RxRequestDetail() {
  const { id } = useParams()
  const service = useRxRequests()
  const navigate = useNavigate()
  const [state, setState] = useState({ status: 'loading', data: null })
  const [cancelling, setCancelling] = useState(false)
  const timer = useRef(null)

  const load = useCallback(() => {
    service
      .get(id)
      .then((data) => setState({ status: 'ready', data }))
      .catch((error) => setState({ status: error?.status === 404 || error?.code === 'NOT_FOUND' ? 'missing' : 'error', data: null }))
  }, [service, id])

  useEffect(load, [load])
  const status = state.data?.status
  useEffect(() => {
    if (!status || ENDED_STATUSES.includes(status) || status === 'QUOTED') return undefined
    timer.current = setInterval(load, POLL_MS)
    return () => clearInterval(timer.current)
  }, [status, load])

  const back = <Link to="/requests" className="inline-flex items-center gap-1 text-caption font-semibold text-brand-600"><ArrowLeft className="h-4 w-4" aria-hidden="true" /> My requests</Link>
  if (state.status === 'loading') return <div className="space-y-3">{back}<Skeleton className="h-40" /></div>
  if (state.status === 'missing') return <div className="space-y-3">{back}<p className="text-body text-fg">This request was not found.</p></div>
  if (state.status === 'error') return <div className="space-y-3">{back}<Button variant="secondary" size="sm" onClick={load}><RefreshCw className="h-4 w-4" aria-hidden="true" /> Try again</Button></div>

  const r = state.data
  const stage = requestStage(r)
  async function cancel() {
    setCancelling(true)
    try {
      await service.cancel(r.id)
    } finally {
      setCancelling(false)
      load()
    }
  }

  return (
    <div className="space-y-6">
      {back}
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="font-display text-h1 text-fg">Prescription request</h1>
        <Badge tone={stage.tone}>{stage.title}</Badge>
      </div>
      <Card className="space-y-1 p-4" role="status" aria-live="polite">
        <p className="text-body font-semibold text-fg">{stage.title}</p>
        <p className="text-caption text-muted">{stage.body}</p>
        <p className="text-caption text-subtle">Sent {when(r.createdAt)} · prescription dated {new Date(r.prescriptionIssueDate).toLocaleDateString()}</p>
        {r.status === 'OPEN' && <p className="text-caption text-subtle">Open to pharmacies until {when(r.expiresAt)}.</p>}
      </Card>

      {r.status === 'QUOTED' && r.quote && <QuoteCard r={r} onConfirmed={(orderId) => navigate(`/orders/${orderId}`)} onChanged={load} />}
      {r.orderId && <Button as={Link} to={`/orders/${r.orderId}`} size="lg">Follow your order</Button>}
      {LIVE_STATUSES.includes(r.status) && (
        <Button variant="ghost" disabled={cancelling} onClick={cancel}>{cancelling ? 'Cancelling…' : 'Cancel this request'}</Button>
      )}
      {['EXPIRED', 'NO_PHARMACY', 'CANCELLED'].includes(r.status) && (
        <p className="text-caption text-muted">You can upload the prescription again and <Link to="/requests/new" className="font-semibold text-brand-600">send a new request</Link>.</p>
      )}
    </div>
  )
}

/** Work 138: the customer's prescription requests, newest first. */
export default function RxRequests() {
  const service = useRxRequests()
  const [state, setState] = useState({ status: 'loading', items: [] })
  useEffect(() => {
    service
      .list()
      .then((items) => setState({ status: 'ready', items }))
      .catch(() => setState({ status: 'error', items: [] }))
  }, [service])

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-display text-h1 text-fg">My prescription requests</h1>
        <Button as={Link} to="/requests/new"><Send className="h-4 w-4" aria-hidden="true" /> Send a prescription</Button>
      </div>
      {state.status === 'loading' && <Skeleton className="h-24" />}
      {state.status === 'error' && <p role="alert" className="text-caption text-danger">Your requests could not be loaded.</p>}
      {state.status === 'ready' && state.items.length === 0 && (
        <Card className="flex flex-col items-center gap-3 p-8 text-center">
          <FileText className="h-8 w-8 text-subtle" aria-hidden="true" />
          <p className="text-body text-fg">Not sure what to buy? Send your prescription and nearby pharmacies will offer the medicines.</p>
        </Card>
      )}
      <div className="space-y-3">
        {state.items.map((r) => {
          const s = requestStage(r)
          return (
            <Card key={r.id} interactive>
              <Link to={`/requests/${r.id}`} className="flex items-center gap-3 rounded-2xl p-4">
                <div className="min-w-0 flex-1">
                  <p className="text-body font-semibold text-fg">{r.pharmacy?.name || 'Prescription request'}</p>
                  <p className="text-caption text-muted">{when(r.createdAt)}{r.quote ? ` · ${money(r.quote.grandTotal, r.quote.currency)}` : ''}</p>
                </div>
                <Badge tone={s.tone}>{s.title}</Badge>
              </Link>
            </Card>
          )
        })}
      </div>
    </div>
  )
}
