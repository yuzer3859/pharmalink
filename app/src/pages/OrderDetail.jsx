import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ArrowLeft, Camera, Check, MapPin, Navigation, PenLine, RefreshCw } from 'lucide-react'
import { Badge, Button, Card, Skeleton } from '../components/ui'
import { formatMinorUnits } from '../lib/utils'
import { useAuth } from '../auth/AuthContext'
import { useOrders } from './Checkout'
import { statusOf } from './Orders'
import { followDelivery } from '../orders/trackingSocket'

const DELIVERY_STATUS = {
  CREATED: 'Finding a driver',
  OFFERED: 'Finding a driver',
  REASSIGNING: 'Finding another driver',
  ASSIGNED: 'Driver assigned',
  ARRIVED_PICKUP: 'Driver at the pharmacy',
  PICKED_UP: 'Picked up',
  EN_ROUTE: 'On the way to you',
  ARRIVED_DROPOFF: 'Driver has arrived',
  DELIVERED: 'Delivered',
  COMPLETED: 'Delivered',
  FAILED: 'Delivery failed',
  CANCELLED: 'Delivery cancelled',
}

function minutes(seconds) {
  const m = Math.max(1, Math.round(seconds / 60))
  return m === 1 ? 'about 1 minute' : `about ${m} minutes`
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
  if (view.status === 'none') return <p className="text-caption text-muted">A driver is assigned once the pharmacy has prepared your order.</p>
  if (view.status === 'error') return <p className="text-caption text-muted">Live tracking isn't available right now.</p>
  const t = view.data
  return (
    <div className="space-y-2" data-testid="tracking">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={t.isFinished ? 'success' : 'brand'}>{DELIVERY_STATUS[t.status] ?? t.status}</Badge>
        {live && !t.isFinished && <span className="text-caption text-success">Live</span>}
      </div>
      {t.eta && !t.isFinished && (
        <p className="flex items-center gap-1.5 text-body text-fg">
          <Navigation className="h-4 w-4 text-brand-500" aria-hidden="true" />
          {t.eta.destination === 'PICKUP' ? 'Reaching the pharmacy in ' : 'Arriving in '}{minutes(t.eta.durationSeconds)}
        </p>
      )}
      {t.location && (
        <p className="flex items-center gap-1.5 text-caption text-muted">
          <MapPin className="h-4 w-4" aria-hidden="true" /> Driver last seen at {t.location.lat.toFixed(4)}, {t.location.lng.toFixed(4)} ({new Date(t.location.recordedAt).toLocaleTimeString()})
        </p>
      )}
      {(t.status === 'DELIVERED' || t.status === 'COMPLETED') && <ProofOfDelivery jobId={t.jobId} />}
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
      setError(e?.message || 'The photo could not be opened.')
    }
  }
  return (
    <Card className="space-y-1 p-3" aria-label="Proof of delivery">
      <p className="flex items-center gap-1.5 text-body font-semibold text-fg">
        {proof.type === 'SIGNATURE' ? <PenLine className="h-4 w-4" aria-hidden="true" /> : <Camera className="h-4 w-4" aria-hidden="true" />} Proof of delivery
      </p>
      <p className="text-caption text-muted">
        {proof.recipientName ? `Received by ${proof.recipientName}` : 'Handed over'} · {new Date(proof.capturedAt).toLocaleString()}
      </p>
      {proof.artifact?.available && <Button variant="ghost" size="sm" onClick={open}>View the {proof.type === 'SIGNATURE' ? 'signature' : 'photo'}</Button>}
      {error && <p role="alert" className="text-caption text-danger">{error}</p>}
    </Card>
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

  const back = <Link to="/orders" className="inline-flex items-center gap-1 text-caption font-semibold text-brand-600"><ArrowLeft className="h-4 w-4" aria-hidden="true" /> My orders</Link>
  if (state.status === 'loading') return <div className="space-y-3">{back}<Skeleton className="h-40" /></div>
  if (state.status === 'missing') return <div className="space-y-3">{back}<p className="text-body text-fg">This order was not found.</p></div>
  if (state.status === 'error') {
    return (
      <div className="space-y-3">
        {back}
        <Button variant="secondary" size="sm" onClick={load}><RefreshCw className="h-4 w-4" aria-hidden="true" /> Try again</Button>
      </div>
    )
  }

  const { order, lines = [], statusHistory = [] } = state.data
  const s = statusOf(order.status)
  const delivering = ['READY', 'DISPATCHED', 'DELIVERED', 'COMPLETED'].includes(order.status)
  return (
    <div className="space-y-6">
      {back}
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="font-display text-h1 text-fg">{order.orderNumber}</h1>
        <Badge tone={s.tone}>{s.label}</Badge>
      </div>
      <p className="text-body text-muted">
        {formatMinorUnits(order.grandTotal, order.currency)} · {order.isCod ? 'cash on delivery' : 'paid online'} · {lines.length === 1 ? '1 item' : `${lines.length} items`}
      </p>

      {delivering && (
        <Card className="p-4">
          <h2 className="mb-2 text-h3 text-fg">Delivery</h2>
          <LiveTracking orderId={order.id} />
        </Card>
      )}

      <Card className="p-4">
        <h2 className="mb-3 text-h3 text-fg">History</h2>
        <ol className="space-y-2" aria-label="Order history">
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
