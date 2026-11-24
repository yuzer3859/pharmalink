import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { motion } from 'framer-motion'
import { Package, PackageCheck, RefreshCw, Truck } from 'lucide-react'
import { PageHero, StaggerItem, StaggerList } from '../components/PageHero'
import { PAGE_PICTURES } from '../catalog/images'
import { Badge, Button, Card, Skeleton } from '../components/ui'
import { formatMinorUnits } from '../lib/utils'
import { useOrders } from './Checkout'
import { t } from '../auth/strings'

/** Customer-facing order states (module-06 §3.4); each label is the message orders.status.<state>. */
export const ORDER_STATUS = {
  PENDING_PAYMENT: 'warning',
  PAID: 'info',
  ACCEPTED: 'info',
  READY: 'info',
  DISPATCHED: 'brand',
  DELIVERED: 'success',
  COMPLETED: 'success',
  CANCELLED: 'neutral',
  REFUNDED: 'neutral',
}

/** Work 152: how far along an order is, 0 to 1, for the bar on its card; null when it has stopped. */
const JOURNEY = ['PAID', 'ACCEPTED', 'READY', 'DISPATCHED', 'DELIVERED']
export function journeyShare(status) {
  if (status === 'PENDING_PAYMENT') return 0.04
  const i = JOURNEY.indexOf(status === 'COMPLETED' ? 'DELIVERED' : status)
  return i < 0 ? null : (i + 1) / JOURNEY.length
}

const TILE = {
  success: 'bg-success/12 text-success',
  warning: 'bg-warning/15 text-warning',
  brand: 'bg-brand-500/12 text-brand-600 dark:text-brand-300',
  info: 'bg-brand-500/12 text-brand-600 dark:text-brand-300',
  neutral: 'bg-surface-2 text-muted',
}

export const statusOf = (status) =>
  ORDER_STATUS[status] ? { label: t(`orders.status.${status}`), tone: ORDER_STATUS[status] } : { label: status, tone: 'neutral' }

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
      <PageHero icon={Package} title={t('common.myOrders')} pictures={PAGE_PICTURES.orders} />
      {state.status === 'loading' && <Skeleton className="h-20" />}
      {state.status === 'error' && (
        <Card className="flex items-center justify-between gap-3 p-4">
          <p className="text-body text-fg">{t('orders.loadFailed')}</p>
          <Button variant="secondary" size="sm" onClick={load}><RefreshCw className="h-4 w-4" aria-hidden="true" /> {t('common.tryAgain')}</Button>
        </Card>
      )}
      {state.status === 'ready' && state.items.length === 0 && (
        <Card className="flex flex-col items-center gap-3 p-8 text-center">
          <Package className="h-8 w-8 text-subtle" aria-hidden="true" />
          <p className="text-body text-fg">{t('orders.empty')}</p>
          <Button as={Link} to="/search" variant="secondary">{t('common.findMedicines')}</Button>
        </Card>
      )}
      {state.status === 'ready' && state.items.length > 0 && (
        <StaggerList className="space-y-3">
          {state.items.map((o) => {
            // Work 133: an order whose prescription the pharmacist is still checking.
            const s = o.rxReviewStatus === 'PENDING' ? { label: t('common.withPharmacist'), tone: 'warning' } : statusOf(o.status)
            const share = journeyShare(o.status)
            const Icon = o.status === 'DISPATCHED' ? Truck : s.tone === 'success' ? PackageCheck : Package
            return (
              <StaggerItem key={o.id} lift>
              <Card interactive className="overflow-hidden">
                <Link to={`/orders/${o.id}`} className="flex items-center gap-3 rounded-2xl p-4">
                  <span className={`grid h-11 w-11 shrink-0 place-items-center rounded-2xl ${TILE[s.tone] ?? TILE.neutral}`} aria-hidden="true">
                    <Icon className="h-5 w-5" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-body font-semibold text-fg">{o.orderNumber}</p>
                    <p className="text-caption text-muted">
                      {o.placedAt ? new Date(o.placedAt).toLocaleString() : ''} · {formatMinorUnits(o.grandTotal, o.currency) ?? ''}
                      {o.isCod ? ` ${t('orders.cod')}` : ''}
                    </p>
                  </div>
                  <Badge tone={s.tone}>{s.label}</Badge>
                </Link>
                {share !== null && (
                  <div className="h-1 bg-border/60" aria-hidden="true">
                    <motion.div
                      className="h-full rounded-r-full bg-gradient-to-r from-brand-500 to-success"
                      initial={{ width: 0 }}
                      animate={{ width: `${share * 100}%` }}
                      transition={{ duration: 0.9, ease: [0.22, 1, 0.36, 1], delay: 0.2 }}
                    />
                  </div>
                )}
              </Card>
              </StaggerItem>
            )
          })}
        </StaggerList>
      )}
    </div>
  )
}
