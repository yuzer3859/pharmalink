import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft, Check, CreditCard, FileText, MapPin, RefreshCw, Send, Smartphone, Store, Wallet, XCircle } from 'lucide-react'
import { Badge, Button, Card, Input, Skeleton } from '../components/ui'
import { formatMinorUnits } from '../lib/utils'
import { useAuth } from '../auth/AuthContext'
import { AddressForm, PrescriptionAttach, useOrders } from './Checkout'
import { PAYMENT_METHODS } from '../orders/ordersService'
import { ENDED_STATUSES, LIVE_STATUSES, createRxRequestsService, requestStage, todayIso } from '../rxRequests/rxRequestsService'
import { t } from '../auth/strings'
import { PageHero, StaggerItem, StaggerList } from '../components/PageHero'
import { PAGE_PICTURES } from '../catalog/images'

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
      setSending({ busy: false, error: error?.message || t('req.sendFailed') })
    }
  }

  return (
    <div className="space-y-6">
      <Link to="/requests" className="inline-flex items-center gap-1 text-caption font-semibold text-brand-600"><ArrowLeft className="h-4 w-4" aria-hidden="true" /> {t('req.my')}</Link>
      <PageHero icon={Send} title={t('common.sendPrescription')} subtitle={t('req.send.intro')} pictures={PAGE_PICTURES.requests} />

      <PrescriptionAttach value={rx} onChange={setRx} intro={t('req.send.file')} />

      <Card className="space-y-3 p-4">
        <label className="block">
          <span className="text-body font-semibold text-fg">{t('req.date')}</span>
          <Input type="date" aria-label={t('req.date')} value={issueDate} max={todayIso()} onChange={(e) => setIssueDate(e.target.value)} className="mt-1" />
          <span className="mt-1 block text-caption text-muted">{t('req.date.hint')}</span>
        </label>
        <label className="block">
          <span className="text-body font-semibold text-fg">{t('req.note')}</span>
          <Input aria-label={t('req.note.label')} placeholder={t('req.note.placeholder')} value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} className="mt-1" />
        </label>
      </Card>

      <Card className="space-y-3 p-4">
        <h2 className="flex items-center gap-2 text-h3 text-fg"><MapPin className="h-5 w-5 text-brand-500" aria-hidden="true" /> {t('req.deliverTo')}</h2>
        {addresses.items.map((a) => (
          <label key={a.id} className="flex items-start gap-3 rounded-xl border border-border p-3">
            <input type="radio" name="address" value={a.id} checked={addressId === a.id} onChange={() => setAddressId(a.id)} />
            <span className="text-body text-fg">{a.recipientName} · {a.addressLine}, {a.city}</span>
          </label>
        ))}
        {addresses.status === 'ready' && addresses.items.length === 0 && !adding && <p className="text-caption text-muted">{t('req.addAddress')}</p>}
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
          <Button variant="ghost" size="sm" onClick={() => setAdding(true)}>{t('common.addAddress')}</Button>
        )}
      </Card>

      {sending.error && <p role="alert" className="text-caption text-danger">{sending.error}</p>}
      <Button size="lg" className="w-full" disabled={!canSend} onClick={send}><Send className="h-4 w-4" aria-hidden="true" /> {t(sending.busy ? 'req.sending' : 'req.submit')}</Button>
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
      setState({ busy: false, error: error?.message || t('checkout.placeFailed') })
      onChanged()
    }
  }
  async function decline() {
    setState({ busy: true, error: null })
    try {
      await service.declineQuote(r.id)
      onChanged()
    } catch (error) {
      setState({ busy: false, error: error?.message || t('req.quote.declineFailed') })
    }
  }

  return (
    <Card className="space-y-3 p-4" aria-label={t('req.quote.title')}>
      <h2 className="flex items-center gap-2 text-h3 text-fg"><Store className="h-5 w-5 text-brand-500" aria-hidden="true" /> {t('req.quote.title')}: {r.pharmacy?.name || t('req.quote.from')}</h2>
      <ul className="space-y-1" aria-label={t('req.quote.medicines')}>
        {q.lines.map((l) => (
          <li key={l.catalogProductId} className="flex justify-between text-body">
            <span className="text-fg">{l.quantity} × {l.name || t('common.medicine')}</span>
            <span className="text-muted">{money(l.lineTotal, q.currency)}</span>
          </li>
        ))}
      </ul>
      <dl className="space-y-1 border-t border-border pt-2 text-body">
        <div className="flex justify-between"><dt className="text-muted">{t('common.delivery')}</dt><dd>{money(q.deliveryFee, q.currency)}</dd></div>
        {q.platformFee > 0 && <div className="flex justify-between"><dt className="text-muted">{t('req.quote.serviceFee')}</dt><dd>{money(q.platformFee, q.currency)}</dd></div>}
        <div className="flex justify-between font-semibold"><dt>{t('common.total')}</dt><dd data-testid="quote-total">{money(q.grandTotal, q.currency)}</dd></div>
      </dl>
      {q.note && <p className="text-caption text-muted">{t('req.quote.note', { note: q.note })}</p>}
      {q.paperRequired ? (
        <p className="rounded-xl bg-warning/10 p-3 text-caption text-fg" role="note">
          <strong>{t('common.paperReady')}</strong> {t('req.quote.paper')}
        </p>
      ) : (
        <p className="text-caption text-muted">{t('req.quote.keepPaper')}</p>
      )}
      {r.quoteExpiresAt && <p className="text-caption text-muted">{t('req.quote.confirmBy', { time: when(r.quoteExpiresAt) })}</p>}

      <div className="grid gap-2 sm:grid-cols-3" role="radiogroup" aria-label={t('common.paymentMethod')}>
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
              <span><span className="block text-body font-semibold text-fg">{t(m.label)}</span><span className="text-caption text-muted">{t(m.desc)}</span></span>
            </button>
          )
        })}
      </div>
      {PAYMENTS_TEST_MODE && method !== 'COD' && (
        <Input aria-label={t('common.testToken')} placeholder={t('common.testToken.placeholder')} value={token} onChange={(e) => setToken(e.target.value)} maxLength={512} />
      )}
      {state.error && <p role="alert" className="text-caption text-danger">{state.error}</p>}
      <div className="flex flex-col gap-2 sm:flex-row">
        <Button className="flex-1" disabled={state.busy} onClick={confirm}><Check className="h-4 w-4" aria-hidden="true" /> {t(state.busy ? 'req.quote.placing' : method === 'COD' ? 'req.quote.confirm' : 'checkout.submit.pay')}</Button>
        <Button variant="ghost" disabled={state.busy} onClick={decline}><XCircle className="h-4 w-4" aria-hidden="true" /> {t('req.quote.decline')}</Button>
      </div>
    </Card>
  )
}

/** "You can upload the prescription again and {link}.", with the link inside the sentence. */
function AgainLine() {
  const [before, after = ''] = t('req.again').split('{link}')
  return (
    <p className="text-caption text-muted">
      {before}
      <Link to="/requests/new" className="font-semibold text-brand-600">{t('req.again.link')}</Link>
      {after}
    </p>
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

  const back = <Link to="/requests" className="inline-flex items-center gap-1 text-caption font-semibold text-brand-600"><ArrowLeft className="h-4 w-4" aria-hidden="true" /> {t('req.my')}</Link>
  if (state.status === 'loading') return <div className="space-y-3">{back}<Skeleton className="h-40" /></div>
  if (state.status === 'missing') return <div className="space-y-3">{back}<p className="text-body text-fg">{t('req.notFound')}</p></div>
  if (state.status === 'error') return <div className="space-y-3">{back}<Button variant="secondary" size="sm" onClick={load}><RefreshCw className="h-4 w-4" aria-hidden="true" /> {t('common.tryAgain')}</Button></div>

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
      <PageHero icon={FileText} title={t('req.title')} pictures={PAGE_PICTURES.requests}>
        <Badge tone={stage.tone} className="ring-1 ring-white/40">{stage.title}</Badge>
      </PageHero>
      <Card className="space-y-1 p-4" role="status" aria-live="polite">
        <p className="text-body font-semibold text-fg">{stage.title}</p>
        <p className="text-caption text-muted">{stage.body}</p>
        <p className="text-caption text-subtle">{t('req.sentLine', { time: when(r.createdAt), date: new Date(r.prescriptionIssueDate).toLocaleDateString() })}</p>
        {r.status === 'OPEN' && <p className="text-caption text-subtle">{t('req.openUntil', { time: when(r.expiresAt) })}</p>}
      </Card>

      {r.status === 'QUOTED' && r.quote && <QuoteCard r={r} onConfirmed={(orderId) => navigate(`/orders/${orderId}`)} onChanged={load} />}
      {r.orderId && <Button as={Link} to={`/orders/${r.orderId}`} size="lg">{t('common.followOrder')}</Button>}
      {LIVE_STATUSES.includes(r.status) && (
        <Button variant="ghost" disabled={cancelling} onClick={cancel}>{t(cancelling ? 'req.cancelling' : 'req.cancel')}</Button>
      )}
      {['EXPIRED', 'NO_PHARMACY', 'CANCELLED'].includes(r.status) && (
        <AgainLine />
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
      <PageHero icon={FileText} title={t('req.list.title')} pictures={PAGE_PICTURES.requests}>
        <Button as={Link} to="/requests/new" variant="secondary" className="mt-1"><Send className="h-4 w-4" aria-hidden="true" /> {t('common.sendPrescription')}</Button>
      </PageHero>
      {state.status === 'loading' && <Skeleton className="h-24" />}
      {state.status === 'error' && <p role="alert" className="text-caption text-danger">{t('req.list.loadFailed')}</p>}
      {state.status === 'ready' && state.items.length === 0 && (
        <Card className="flex flex-col items-center gap-3 p-8 text-center">
          <FileText className="h-8 w-8 text-subtle" aria-hidden="true" />
          <p className="text-body text-fg">{t('req.list.empty')}</p>
        </Card>
      )}
      <StaggerList className="space-y-3">
        {state.items.map((r) => {
          const s = requestStage(r)
          return (
            <StaggerItem key={r.id} lift>
            <Card interactive>
              <Link to={`/requests/${r.id}`} className="flex items-center gap-3 rounded-2xl p-4">
                <span className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-brand-500/12 text-brand-600 dark:text-brand-300" aria-hidden="true"><Store className="h-5 w-5" /></span>
                <div className="min-w-0 flex-1">
                  <p className="text-body font-semibold text-fg">{r.pharmacy?.name || t('req.title')}</p>
                  <p className="text-caption text-muted">{when(r.createdAt)}{r.quote ? ` · ${money(r.quote.grandTotal, r.quote.currency)}` : ''}</p>
                </div>
                <Badge tone={s.tone}>{s.title}</Badge>
              </Link>
            </Card>
            </StaggerItem>
          )
        })}
      </StaggerList>
    </div>
  )
}
