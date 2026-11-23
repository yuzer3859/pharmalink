import { useEffect, useState } from 'react'
import { Link, useLocation, useParams } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import { useOrders } from './Checkout'
import { AlertTriangle, ArrowLeft, Ban, RefreshCw, ShieldAlert, Store, Thermometer } from 'lucide-react'
import { motion } from 'framer-motion'
import { Badge, Button, Card, Skeleton } from '../components/ui'
import ProductImage from '../components/ProductImage'
import { cartChanged } from '../lib/cartEvents'
import { cn } from '../lib/utils'
import { formatMinorUnits } from '../lib/utils'
import { useCatalog } from '../catalog/catalogService'
import { categoryName, humanize, productName, strength, summarizeAvailability } from '../catalog/format'
import { RxBadge } from './Medicines'
import { t } from '../auth/strings'

/**
 * Work 100: puts the product in the signed-in customer's cart (Module 06). A signed-out visitor is
 * sent to log in and brought back here. Prices and stock are confirmed by the server at checkout.
 */
function AddToCart({ product }) {
  const { status } = useAuth()
  const orders = useOrders()
  const location = useLocation()
  const [quantity, setQuantity] = useState(1)
  const [state, setState] = useState({ status: 'idle', error: null })
  if (product.status && product.status !== 'ACTIVE') return null

  async function add() {
    setState({ status: 'adding', error: null })
    try {
      await orders.addToCart(product.id, quantity)
      setState({ status: 'added', error: null })
      cartChanged()
    } catch (error) {
      setState({ status: 'idle', error: error?.message || t('product.addFailed') })
    }
  }

  return (
    <Card className="space-y-3 p-4">
      {status !== 'signedIn' ? (
        <Button as={Link} to="/login" state={{ from: location.pathname }} className="w-full">{t('product.loginToAdd')}</Button>
      ) : (
        <>
          <div className="flex items-center gap-3">
            <label className="text-caption text-muted" htmlFor="qty">{t('common.quantity')}</label>
            <input id="qty" type="number" min={1} max={99} value={quantity} onChange={(e) => setQuantity(Math.max(1, Math.min(99, Number(e.target.value) || 1)))} className="h-10 w-20 rounded-xl border border-border bg-surface px-3 text-body text-fg" />
          </div>
          <Button className="w-full" disabled={state.status === 'adding'} onClick={add}>{t(state.status === 'adding' ? 'product.adding' : 'product.add')}</Button>
          {state.status === 'added' && (
            <p role="status" className="text-caption text-success">{t('product.added')} <Link to="/checkout" className="font-semibold underline">{t('common.goToCheckout')}</Link></p>
          )}
          {state.error && <p role="alert" className="text-caption text-danger">{state.error}</p>}
        </>
      )}
      {product.rxClassification === 'RX' && <p className="text-caption text-subtle">{t('product.rxNote')}</p>}
    </Card>
  )
}

/**
 * Work 147: the product's pictures, the main one large with a soft entrance and hover zoom, and the
 * others as thumbnails to switch between. With no picture, a placeholder takes its place.
 */
function Gallery({ images }) {
  const [current, setCurrent] = useState(0)
  const list = images.filter(Boolean)
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.96 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.55, ease: [0.22, 1, 0.36, 1] }}
      className="space-y-3"
    >
      <div className="group overflow-hidden rounded-3xl border border-border shadow-lg">
        <ProductImage key={list[current] ?? 'none'} src={list[current]} zoom eager iconSize="h-16 w-16" className="aspect-square w-full" />
      </div>
      {list.length > 1 && (
        <div className="flex gap-2">
          {list.map((src, i) => (
            <button
              key={src}
              type="button"
              onClick={() => setCurrent(i)}
              aria-pressed={i === current}
              aria-label={String(i + 1)}
              className={cn(
                'overflow-hidden rounded-xl border-2 transition-all',
                i === current ? 'border-brand-500 shadow-md' : 'border-transparent opacity-70 hover:opacity-100',
              )}
            >
              <ProductImage src={src} className="h-16 w-16" iconSize="h-5 w-5" />
            </button>
          ))}
        </div>
      )}
    </motion.div>
  )
}

function safeBackLink(from) {
  return typeof from === 'string' && from.startsWith('/medicines') && !from.startsWith('//') ? from : '/medicines'
}

function Row({ label, children }) {
  if (children == null || children === '') return null
  return (
    <div className="flex flex-col gap-0.5 py-3 sm:flex-row sm:justify-between sm:gap-6">
      <dt className="text-caption font-semibold text-muted">{label}</dt>
      <dd className="text-body text-fg sm:text-right">{children}</dd>
    </div>
  )
}

/**
 * Selling prices come only from Inventory listings. The endpoint returns no pharmacy or branch
 * names, so listings are shown in aggregate (count and price range) rather than by pharmacy, and
 * their ids are never displayed. No location is sent, so no distance is shown.
 */
function Availability({ product }) {
  const catalog = useCatalog()
  const [state, setState] = useState({ status: 'loading', items: [] })
  const [attempt, setAttempt] = useState(0)
  const prohibited = product.onlineSaleProhibited === true

  useEffect(() => {
    if (prohibited) return undefined
    const controller = new AbortController()
    setState({ status: 'loading', items: [] })
    catalog
      .getAvailability(product.id, { signal: controller.signal })
      .then((items) => setState({ status: 'ready', items }))
      .catch((error) => error?.code !== 'ABORTED' && setState({ status: 'error', items: [], error }))
    return () => controller.abort()
  }, [catalog, product.id, prohibited, attempt])

  if (prohibited) {
    return (
      <Card className="p-5">
        <div className="flex items-start gap-3">
          <Ban className="mt-0.5 h-5 w-5 shrink-0 text-danger" aria-hidden="true" />
          <div>
            <p className="text-body-lg font-semibold text-fg">{t('product.notForSale')}</p>
            <p className="mt-1 text-body text-muted">{t('product.notForSale.body')}</p>
          </div>
        </div>
      </Card>
    )
  }

  const summary = summarizeAvailability(state.items)
  return (
    <Card className="p-5" aria-live="polite" aria-busy={state.status === 'loading'}>
      <div className="flex items-center gap-2">
        <Store className="h-5 w-5 text-brand-500" aria-hidden="true" />
        <h2 className="text-h3 text-fg">{t('product.availability')}</h2>
      </div>

      {state.status === 'loading' && (
        <div role="status" className="mt-4 space-y-2">
          <span className="sr-only">{t('product.availability.checking')}</span>
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-8 w-56" />
        </div>
      )}

      {state.status === 'error' && (
        <div role="alert" className="mt-4 space-y-3">
          <p className="text-body text-muted">
            {t(state.error?.code === 'NETWORK_ERROR' ? 'product.availability.offline' : 'product.availability.error')}{' '}
            {t('product.availability.notOut')}
          </p>
          <Button variant="secondary" size="sm" onClick={() => setAttempt((n) => n + 1)}>
            <RefreshCw className="h-4 w-4" aria-hidden="true" /> {t('common.tryAgain')}
          </Button>
        </div>
      )}

      {state.status === 'ready' && summary.count === 0 && (
        <p className="mt-4 text-body text-muted">{t('product.availability.none')}</p>
      )}

      {state.status === 'ready' && summary.count > 0 && (
        <div className="mt-4 space-y-3">
          <Badge tone="success" dot>
            {t(summary.count === 1 ? 'product.listings.one' : 'product.listings.many', { count: summary.atLeast ? `${summary.count}+` : summary.count })}
          </Badge>
          {summary.ranges.map((r) => (
            <div key={r.currency}>
              <p className="text-caption font-semibold text-muted">
                {t(r.min === r.max ? 'product.price.one' : 'product.price.many')}
              </p>
              <p className="text-h2 font-bold text-fg">{r.label}</p>
            </div>
          ))}
          <p className="text-caption text-subtle">
            {t('product.price.note')}
          </p>
        </div>
      )}
    </Card>
  )
}

export default function MedicineDetail() {
  const { id } = useParams()
  const location = useLocation()
  const catalog = useCatalog()
  const [state, setState] = useState({ status: 'loading', product: null })
  const [attempt, setAttempt] = useState(0)
  const back = safeBackLink(location.state?.from)

  useEffect(() => {
    const controller = new AbortController()
    setState({ status: 'loading', product: null })
    catalog
      .getProduct(id, { signal: controller.signal })
      .then((product) => setState({ status: 'ready', product }))
      .catch((error) => {
        if (error?.code === 'ABORTED') return
        setState({ status: error?.status === 404 ? 'notFound' : 'error', product: null, error })
      })
    return () => controller.abort()
  }, [catalog, id, attempt])

  const backLink = (
    <Link to={back} className="inline-flex items-center gap-1.5 text-caption font-semibold text-brand-600 hover:underline dark:text-brand-300">
      <ArrowLeft className="h-4 w-4" aria-hidden="true" /> {t('product.back')}
    </Link>
  )

  if (state.status === 'loading') {
    return (
      <div className="space-y-5" role="status" aria-live="polite">
        {backLink}
        <span className="sr-only">{t('product.loading')}</span>
        <Skeleton className="h-10 w-2/3" />
        <Skeleton className="h-48 rounded-2xl" />
      </div>
    )
  }

  if (state.status === 'notFound' || state.status === 'error') {
    const notFound = state.status === 'notFound'
    return (
      <div className="mx-auto max-w-xl space-y-5 py-6">
        {backLink}
        <Card role="alert" className="flex flex-col items-center gap-3 p-8 text-center">
          <p className="text-body-lg font-semibold text-fg">{t(notFound ? 'product.notFound' : 'product.loadFailed')}</p>
          <p className="text-body text-muted">
            {t(notFound ? 'product.notFound.body' : state.error?.code === 'NETWORK_ERROR' ? 'common.offline' : 'common.catalogError')}
          </p>
          {!notFound && (
            <Button variant="secondary" onClick={() => setAttempt((n) => n + 1)}>
              <RefreshCw className="h-4 w-4" aria-hidden="true" /> {t('common.tryAgain')}
            </Button>
          )}
        </Card>
      </div>
    )
  }

  const p = state.product
  const name = productName(p)
  const referencePrice = p.price == null ? null : formatMinorUnits(p.price, 'ETB')
  const controlled = p.controlledSchedule && p.controlledSchedule !== 'NONE'

  return (
    <div className="space-y-5">
      {backLink}

      <div className="grid gap-6 md:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] md:items-center">
        <Gallery images={Array.isArray(p.images) && p.images.length > 0 ? p.images : [p.imageUrl]} />
        <motion.div
          className="min-w-0"
          initial={{ opacity: 0, x: 16 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.5, delay: 0.1, ease: [0.22, 1, 0.36, 1] }}
        >
          <div className="flex flex-wrap items-center gap-2">
            <RxBadge rx={p.rxClassification} />
            <Badge tone="neutral">{t(p.type === 'HEALTH_PRODUCT' ? 'common.healthProduct' : 'common.medicine')}</Badge>
            {controlled && <Badge tone="danger">{t('product.controlled', { schedule: humanize(p.controlledSchedule) })}</Badge>}
          </div>
          <h1 className="mt-3 font-display text-h1 text-fg sm:text-display">{name}</h1>
          {p.nameAm && p.nameAm !== name && <p lang="am" className="mt-1 text-body-lg text-muted">{p.nameAm}</p>}
          {p.genericName && p.genericName !== name && <p className="text-body text-muted">{p.genericName}</p>}
          {p.descriptionEn && <p className="mt-4 max-w-prose text-body-lg text-muted">{p.descriptionEn}</p>}
        </motion.div>
      </div>

      {p.status === 'DEPRECATED' && (
        <Card role="note" className="flex items-start gap-3 border-warning/40 p-4">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-warning" aria-hidden="true" />
          <p className="text-body text-muted">{t('product.discontinued')}</p>
        </Card>
      )}

      {p.rxClassification === 'RX' && (
        <Card role="note" className="flex items-start gap-3 p-4">
          <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-warning" aria-hidden="true" />
          <p className="text-body text-muted">{t('product.rxOnly')}</p>
        </Card>
      )}

      <div className="grid gap-5 lg:grid-cols-5">
        <div className="space-y-5 lg:col-span-3">
          <Card className="px-5">
            <dl className="divide-y divide-border">
              <Row label={t('product.brand')}>{p.brandName}</Row>
              <Row label={t('product.generic')}>{p.genericName}</Row>
              <Row label={t('product.form')}>{humanize(p.dosageForm)}</Row>
              <Row label={t('product.strength')}>{strength(p)}</Row>
              <Row label={t('product.pack')}>{p.packSize}</Row>
              <Row label={t('product.classification')}>
                {p.rxClassification === 'RX' ? t('product.class.rx') : p.rxClassification === 'OTC' ? t('product.class.otc') : null}
              </Row>
              <Row label={t('product.storage')}>
                {p.storageRequirement && (
                  <span className="inline-flex items-center gap-1.5">
                    <Thermometer className="h-4 w-4 text-muted" aria-hidden="true" /> {humanize(p.storageRequirement)}
                  </span>
                )}
              </Row>
              {referencePrice && (
                <Row label={t('product.refPrice')}>
                  {referencePrice}
                  <span className="block text-caption text-subtle">{t('product.refPrice.note')}</span>
                </Row>
              )}
            </dl>
          </Card>

          {p.warnings && (
            <Card className="p-5">
              <div className="flex items-center gap-2">
                <AlertTriangle className="h-5 w-5 text-warning" aria-hidden="true" />
                <h2 className="text-h3 text-fg">{t('product.warnings')}</h2>
              </div>
              <p className="mt-2 whitespace-pre-line text-body text-muted">{p.warnings}</p>
            </Card>
          )}

          {/* Work 147: the English description now opens the page, beside the picture. */}
          {p.descriptionAm && (
            <Card className="p-5">
              <h2 className="text-h3 text-fg">{t('product.about')}</h2>
              {p.descriptionAm && <p lang="am" className="mt-2 whitespace-pre-line text-body text-muted">{p.descriptionAm}</p>}
            </Card>
          )}

          <p className="text-caption text-subtle">
            {t('product.disclaimer')}
          </p>

          {p.categories.length > 0 && (
            <div className="flex flex-wrap gap-2" aria-label={t('product.categories')}>
              {p.categories.map((c) => (
                <Link key={c.id} to={`/medicines?category=${c.id}`}>
                  <Badge tone="brand">{categoryName(c)}</Badge>
                </Link>
              ))}
            </div>
          )}
        </div>

        <div className="space-y-4 lg:col-span-2">
          <AddToCart product={p} />
          <Availability product={p} />
        </div>
      </div>
    </div>
  )
}
