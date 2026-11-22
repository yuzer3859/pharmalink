import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ArrowLeft, Camera, Check, FileText, MapPin, Navigation, PenLine, RefreshCw, XCircle } from 'lucide-react'
import { Badge, Button, Card, Input, Skeleton } from '../components/ui'
import { formatMinorUnits } from '../lib/utils'
import { useAuth } from '../auth/AuthContext'
import { useOrders } from './Checkout'
import { statusOf } from './Orders'
import { followDelivery } from '../orders/trackingSocket'
import { PAYMENT_METHODS } from '../orders/ordersService'
import { t } from '../auth/strings'

/** The delivery's state, as a message key (Work 143). */
const DELIVERY_STATUS = {
  CREATED: 'delivery.status.finding',
  OFFERED: 'delivery.status.finding',
  REASSIGNING: 'delivery.status.REASSIGNING',
  ASSIGNED: 'delivery.status.ASSIGNED',
  ARRIVED_PICKUP: 'delivery.status.ARRIVED_PICKUP',
  PICKED_UP: 'delivery.status.PICKED_UP',
  EN_ROUTE: 'delivery.status.EN_ROUTE',
  ARRIVED_DROPOFF: 'delivery.status.ARRIVED_DROPOFF',
  DELIVERED: 'orders.status.DELIVERED',
  COMPLETED: 'orders.status.DELIVERED',
  FAILED: 'delivery.status.FAILED',
  CANCELLED: 'delivery.status.CANCELLED',
}

function minutes(seconds) {
  const m = Math.max(1, Math.round(seconds / 60))
  return m === 1 ? t('delivery.minutes.one') : t('delivery.minutes.many', { count: m })
}

/** Live delivery: the snapshot, then pushed updates while the delivery is moving. */
function LiveTracking({ orderId }) {
  const orders = useOrders()
  const { accessToken } = useAuth()
  const [view, setView] = useState({ status: 'loading', data: null })
  const [live, setLive] = useState(false)

  useEffect(() => {
    let stop = null
    let active = true
    orders
      .tracking(orderId)
      .then(async (snapshot) => {
        if (!active) return
        setView({ status: 'ready', data: snapshot })
        if (snapshot.isFinished) return
        const token = await accessToken()
        if (!active) return
        stop = followDelivery({
          jobId: snapshot.jobId,
          token,
          onView: (next) => {
            setLive(true)
            setView({ status: 'ready', data: next })
          },
          onError: () => setLive(false),
        })
      })
      .catch((error) => active && setView({ status: error?.code === 'NOT_FOUND' ? 'none' : 'error', data: null }))
    return () => {
      active = false
      stop?.()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orders, orderId])

  if (view.status === 'loading') return <Skeleton className="h-24" />
  if (view.status === 'none') return <p className="text-caption text-muted">{t('delivery.assignedLater')}</p>
  if (view.status === 'error') return <p className="text-caption text-muted">{t('delivery.trackingUnavailable')}</p>
  const track = view.data
  return (
    <div className="space-y-2" data-testid="tracking">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={track.isFinished ? 'success' : 'brand'}>{DELIVERY_STATUS[track.status] ? t(DELIVERY_STATUS[track.status]) : track.status}</Badge>
        {live && !track.isFinished && <span className="text-caption text-success">{t('delivery.live')}</span>}
      </div>
      {track.eta && !track.isFinished && (
        <p className="flex items-center gap-1.5 text-body text-fg">
          <Navigation className="h-4 w-4 text-brand-500" aria-hidden="true" />
          {t(track.eta.destination === 'PICKUP' ? 'delivery.eta.pickup' : 'delivery.eta.dropoff', { minutes: minutes(track.eta.durationSeconds) })}
        </p>
      )}
      {track.location && (
        <p className="flex items-center gap-1.5 text-caption text-muted">
          <MapPin className="h-4 w-4" aria-hidden="true" />{' '}
          {t('delivery.lastSeen', {
            position: `${track.location.lat.toFixed(4)}, ${track.location.lng.toFixed(4)}`,
            time: new Date(track.location.recordedAt).toLocaleTimeString(),
          })}
        </p>
      )}
      {(track.status === 'DELIVERED' || track.status === 'COMPLETED') && <ProofOfDelivery jobId={track.jobId} />}
    </div>
  )
}

function ProofOfDelivery({ jobId }) {
  const orders = useOrders()
  const [proof, setProof] = useState(null)
  const [error, setError] = useState(null)
  useEffect(() => {
    orders.proofOfDelivery(jobId).then(setProof).catch(() => setProof(null))
  }, [orders, jobId])
  if (!proof) return null
  async function open() {
    try {
      const link = await orders.proofLink(jobId)
      window.open(link.url, '_blank', 'noopener')
    } catch (e) {
      setError(e?.message || t('pod.openFailed'))
    }
  }
  return (
    <Card className="space-y-1 p-3" aria-label={t('pod.title')}>
      <p className="flex items-center gap-1.5 text-body font-semibold text-fg">
        {proof.type === 'SIGNATURE' ? <PenLine className="h-4 w-4" aria-hidden="true" /> : <Camera className="h-4 w-4" aria-hidden="true" />} {t('pod.title')}
      </p>
      <p className="text-caption text-muted">
        {proof.recipientName ? t('pod.receivedBy', { name: proof.recipientName }) : t('pod.handedOver')} · {new Date(proof.capturedAt).toLocaleString()}
      </p>
      {proof.artifact?.available && <Button variant="ghost" size="sm" onClick={open}>{t(proof.type === 'SIGNATURE' ? 'pod.viewSignature' : 'pod.viewPhoto')}</Button>}
      {error && <p role="alert" className="text-caption text-danger">{error}</p>}
    </Card>
  )
}

/** The test gateway's token field appears only in a build that turns test mode on (staging). */
const PAYMENTS_TEST_MODE = import.meta.env.VITE_PAYMENTS_TEST_MODE === 'true'

/**
 * Work 133: where the prescription on this order stands. While the pharmacist checks it nothing is
 * charged; once approved, a pay-now order is paid here; a rejection shows the pharmacist's reason.
 */
export function PrescriptionPanel({ order, onChanged }) {
  const orders = useOrders()
  const [method, setMethod] = useState(order.payment?.method && order.payment.method !== 'COD' ? order.payment.method : 'TELEBIRR')
  const [token, setToken] = useState('')
  const [paying, setPaying] = useState({ busy: false, error: null })
  const review = order.rxReviewStatus
  if (!review) return null

  async function pay() {
    setPaying({ busy: true, error: null })
    try {
      await orders.payOrder(order.id, { method, token: PAYMENTS_TEST_MODE ? token.trim() : undefined })
      setPaying({ busy: false, error: null })
      onChanged()
    } catch (error) {
      setPaying({ busy: false, error: error?.message || t('order.payFailed') })
      if (error?.code === 'PAYMENT_AUTH_FAILED') onChanged()
    }
  }

  if (review === 'PENDING') {
    return (
      <Card className="flex items-start gap-3 p-4" role="status" aria-label={t('common.prescription')}>
        <FileText className="mt-0.5 h-5 w-5 text-brand-500" aria-hidden="true" />
        <div>
          <p className="text-body font-semibold text-fg">{t('common.withPharmacist')}</p>
          <p className="text-caption text-muted">
            {t('order.rx.checking')}{' '}
            {t(order.isCod ? 'order.rx.thenPrepare' : 'order.rx.thenPay')}
          </p>
          <Button variant="ghost" size="sm" className="mt-2" onClick={onChanged}><RefreshCw className="h-4 w-4" aria-hidden="true" /> {t('common.checkAgain')}</Button>
        </div>
      </Card>
    )
  }
  if (review === 'REJECTED') {
    return (
      <Card role="alert" className="flex items-start gap-3 border-danger/40 p-4" aria-label={t('common.prescription')}>
        <XCircle className="mt-0.5 h-5 w-5 text-danger" aria-hidden="true" />
        <div>
          <p className="text-body font-semibold text-fg">{t('order.rx.rejected')}</p>
          <p className="text-caption text-muted">
            {order.cancelReason ? `${order.cancelReason} ` : ''}{t('common.cancelledNothingCharged')}
          </p>
        </div>
      </Card>
    )
  }
  if (order.status === 'PENDING_PAYMENT' && !order.isCod) {
    return (
      <Card className="space-y-3 p-4" aria-label={t('common.prescription')}>
        <p className="flex items-center gap-2 text-body font-semibold text-fg"><Check className="h-5 w-5 text-success" aria-hidden="true" /> {t('order.rx.approvedPay')}</p>
        <p className="text-caption text-muted">{t('order.pay')} {formatMinorUnits(order.grandTotal, order.currency)}</p>
        <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={t('common.paymentMethod')}>
          {PAYMENT_METHODS.filter((m) => m.id !== 'COD').map((m) => (
            <button
              key={m.id}
              type="button"
              role="radio"
              aria-checked={method === m.id}
              onClick={() => setMethod(m.id)}
              className={`rounded-xl border px-3 py-2 text-body ${method === m.id ? 'border-brand-500 bg-brand-500/5' : 'border-border'}`}
            >
              {t(m.label)}
            </button>
          ))}
        </div>
        {PAYMENTS_TEST_MODE && (
          <div>
            <Input aria-label={t('common.testToken')} placeholder={t('common.testToken.placeholder')} value={token} onChange={(e) => setToken(e.target.value)} maxLength={512} />
            <p className="mt-1 text-caption text-subtle">{t('order.testMode')}</p>
          </div>
        )}
        <Button onClick={pay} disabled={paying.busy}>{t(paying.busy ? 'order.paying' : 'order.payNow')}</Button>
        {paying.error && <p role="alert" className="text-caption text-danger">{paying.error}</p>}
      </Card>
    )
  }
  return (
    <p className="flex items-center gap-1.5 text-caption text-success" aria-label={t('common.prescription')}>
      <Check className="h-4 w-4" aria-hidden="true" /> {t('order.rx.approved')}
    </p>
  )
}

/** Work 102: one order on the real API: its status history, live delivery and proof of delivery. */
export default function OrderDetail() {
  const { id } = useParams()
  const orders = useOrders()
  const [state, setState] = useState({ status: 'loading', data: null })

  function load() {
    setState((s) => ({ ...s, status: 'loading' }))
    orders
      .order(id)
      .then((data) => setState({ status: 'ready', data }))
      .catch((error) => setState({ status: error?.code === 'ORDER_NOT_FOUND' || error?.status === 404 ? 'missing' : 'error', data: null }))
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, [orders, id])

  const back = <Link to="/orders" className="inline-flex items-center gap-1 text-caption font-semibold text-brand-600"><ArrowLeft className="h-4 w-4" aria-hidden="true" /> {t('common.myOrders')}</Link>
  if (state.status === 'loading') return <div className="space-y-3">{back}<Skeleton className="h-40" /></div>
  if (state.status === 'missing') return <div className="space-y-3">{back}<p className="text-body text-fg">{t('order.notFound')}</p></div>
  if (state.status === 'error') {
    return (
      <div className="space-y-3">
        {back}
        <Button variant="secondary" size="sm" onClick={load}><RefreshCw className="h-4 w-4" aria-hidden="true" /> {t('common.tryAgain')}</Button>
      </div>
    )
  }

  const { order, lines = [], statusHistory = [] } = state.data
  const s = order.rxReviewStatus === 'PENDING' ? { label: t('common.withPharmacist'), tone: 'warning' } : statusOf(order.status)
  const delivering = ['READY', 'DISPATCHED', 'DELIVERED', 'COMPLETED'].includes(order.status)
  return (
    <div className="space-y-6">
      {back}
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="font-display text-h1 text-fg">{order.orderNumber}</h1>
        <Badge tone={s.tone}>{s.label}</Badge>
      </div>
      <p className="text-body text-muted">
        {formatMinorUnits(order.grandTotal, order.currency)} · {order.isCod ? t('orders.cod').replace(/^·\s*/, '') : order.status === 'PENDING_PAYMENT' || order.status === 'CANCELLED' ? t('order.payOnline') : t('order.paidOnline')} · {lines.length === 1 ? t('order.items.one') : t('order.items.many', { count: lines.length })}
      </p>

      <PrescriptionPanel order={order} onChanged={load} />

      {order.paperRxRequired && !['DELIVERED', 'COMPLETED', 'CANCELLED'].includes(order.status) && (
        // Work 138: the original paper goes to the pharmacist first (Work 136).
        <Card className="flex items-start gap-3 border-warning/40 p-4" role="note" aria-label={t('order.paper.title')}>
          <FileText className="mt-0.5 h-5 w-5 text-warning" aria-hidden="true" />
          <p className="text-caption text-fg">
            <strong>{t('common.paperReady')}</strong> {t('order.paper.body')}
          </p>
        </Card>
      )}

      {delivering && (
        <Card className="p-4">
          <h2 className="mb-2 text-h3 text-fg">{t('common.delivery')}</h2>
          <LiveTracking orderId={order.id} />
        </Card>
      )}

      <Card className="p-4">
        <h2 className="mb-3 text-h3 text-fg">{t('order.history')}</h2>
        <ol className="space-y-2" aria-label={t('order.history.label')}>
          {statusHistory.map((h, i) => (
            <li key={h.id ?? i} className="flex items-start gap-2">
              <Check className="mt-0.5 h-4 w-4 text-success" aria-hidden="true" />
              <span className="text-body text-fg">
                {statusOf(h.toStatus).label}
                <span className="block text-caption text-muted">{h.createdAt ? new Date(h.createdAt).toLocaleString() : ''}{h.reason ? ` · ${h.reason}` : ''}</span>
              </span>
            </li>
          ))}
        </ol>
      </Card>
    </div>
  )
}
