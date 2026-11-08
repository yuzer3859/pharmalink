import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Package, RefreshCw } from 'lucide-react'
import { Badge, Button, Card, Skeleton } from '../components/ui'
import { formatMinorUnits } from '../lib/utils'
import { useOrders } from './Checkout'

/** Customer-facing order states (module-06 §3.4). */
export const ORDER_STATUS = {
  PENDING_PAYMENT: { label: 'Waiting for payment', tone: 'warning' },
  PAID: { label: 'Sent to the pharmacy', tone: 'info' },
  ACCEPTED: { label: 'Pharmacy is preparing it', tone: 'info' },
  READY: { label: 'Ready for the driver', tone: 'info' },
  DISPATCHED: { label: 'On the way', tone: 'brand' },
  DELIVERED: { label: 'Delivered', tone: 'success' },
  COMPLETED: { label: 'Completed', tone: 'success' },
  CANCELLED: { label: 'Cancelled', tone: 'neutral' },
  REFUNDED: { label: 'Refunded', tone: 'neutral' },
}

export const statusOf = (status) => ORDER_STATUS[status] ?? { label: status, tone: 'neutral' }

/** Work 102: the customer's orders, newest first, on the real API. */
export default function Orders() {
  const orders = useOrders()
  const [state, setState] = useState({ status: 'loading', items: [] })

  function load() {
    setState((s) => ({ ...s, status: 'loading' }))
    orders
      .orders()
      .then((items) => setState({ status: 'ready', items }))
      .catch(() => setState({ status: 'error', items: [] }))
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, [orders])

  return (
    <div className="space-y-6">
      <h1 className="font-display text-h1 text-fg">My orders</h1>
      {state.status === 'loading' && <Skeleton className="h-20" />}
      {state.status === 'error' && (
        <Card className="flex items-center justify-between gap-3 p-4">
          <p className="text-body text-fg">Your orders could not be loaded.</p>
          <Button variant="secondary" size="sm" onClick={load}><RefreshCw className="h-4 w-4" aria-hidden="true" /> Try again</Button>
        </Card>
      )}
      {state.status === 'ready' && state.items.length === 0 && (
        <Card className="flex flex-col items-center gap-3 p-8 text-center">
          <Package className="h-8 w-8 text-subtle" aria-hidden="true" />
          <p className="text-body text-fg">You have no orders yet.</p>
          <Button as={Link} to="/search" variant="secondary">Find medicines</Button>
        </Card>
      )}
      {state.status === 'ready' && state.items.length > 0 && (
        <div className="space-y-3">
          {state.items.map((o) => {
            const s = statusOf(o.status)
            return (
              <Card key={o.id} interactive>
                <Link to={`/orders/${o.id}`} className="flex items-center gap-3 rounded-2xl p-4">
                  <div className="min-w-0 flex-1">
                    <p className="text-body font-semibold text-fg">{o.orderNumber}</p>
                    <p className="text-caption text-muted">
                      {o.placedAt ? new Date(o.placedAt).toLocaleString() : ''} · {formatMinorUnits(o.grandTotal, o.currency) ?? ''}
                      {o.isCod ? ' · cash on delivery' : ''}
                    </p>
                  </div>
                  <Badge tone={s.tone}>{s.label}</Badge>
                </Link>
              </Card>
            )
          })}
        </div>
      )}
    </div>
  )
}
