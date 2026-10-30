import { useEffect, useState } from 'react'
import { Link, useLocation, useParams } from 'react-router-dom'
import { AlertTriangle, ArrowLeft, Ban, Pill, RefreshCw, ShieldAlert, Store, Thermometer } from 'lucide-react'
import { Badge, Button, Card, Skeleton } from '../components/ui'
import { formatMinorUnits } from '../lib/utils'
import { useCatalog } from '../catalog/catalogService'
import { categoryName, humanize, productName, strength, summarizeAvailability } from '../catalog/format'
import { RxBadge } from './Medicines'

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
            <p className="text-body-lg font-semibold text-fg">Not available for online sale</p>
            <p className="mt-1 text-body text-muted">This product can't be sold through PharmaLink. Ask a pharmacist or your doctor.</p>
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
        <h2 className="text-h3 text-fg">Pharmacy availability</h2>
      </div>

      {state.status === 'loading' && (
        <div role="status" className="mt-4 space-y-2">
          <span className="sr-only">Checking pharmacy availability…</span>
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-8 w-56" />
        </div>
      )}

      {state.status === 'error' && (
        <div role="alert" className="mt-4 space-y-3">
          <p className="text-body text-muted">
            {state.error?.code === 'NETWORK_ERROR'
              ? 'We could not reach PharmaLink to check availability.'
              : 'Availability could not be checked right now.'}{' '}
            This does not mean the product is out of stock.
          </p>
          <Button variant="secondary" size="sm" onClick={() => setAttempt((n) => n + 1)}>
            <RefreshCw className="h-4 w-4" aria-hidden="true" /> Try again
          </Button>
        </div>
      )}

      {state.status === 'ready' && summary.count === 0 && (
        <p className="mt-4 text-body text-muted">No pharmacy listings are available for this product right now.</p>
      )}

      {state.status === 'ready' && summary.count > 0 && (
        <div className="mt-4 space-y-3">
          <Badge tone="success" dot>
            {summary.atLeast ? `${summary.count}+` : summary.count} available {summary.count === 1 ? 'listing' : 'listings'}
          </Badge>
          {summary.ranges.map((r) => (
            <div key={r.currency}>
              <p className="text-caption font-semibold text-muted">
                {r.min === r.max ? 'Pharmacy selling price' : 'Pharmacy selling prices'}
              </p>
              <p className="text-h2 font-bold text-fg">{r.label}</p>
            </div>
          ))}
          <p className="text-caption text-subtle">
            Prices are set by each pharmacy. Pharmacy names and distances aren't shown yet; ordering is not available in this version.
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
      <ArrowLeft className="h-4 w-4" aria-hidden="true" /> Back to medicines
    </Link>
  )

  if (state.status === 'loading') {
    return (
      <div className="space-y-5" role="status" aria-live="polite">
        {backLink}
        <span className="sr-only">Loading product…</span>
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
          <p className="text-body-lg font-semibold text-fg">{notFound ? 'Product not found' : "We couldn't load this product."}</p>
          <p className="text-body text-muted">
            {notFound
              ? 'This product is not in the catalog, or is no longer available.'
              : state.error?.code === 'NETWORK_ERROR'
                ? 'PharmaLink could not be reached. Check your connection and try again.'
                : 'The catalog service returned an error. Please try again.'}
          </p>
          {!notFound && (
            <Button variant="secondary" onClick={() => setAttempt((n) => n + 1)}>
              <RefreshCw className="h-4 w-4" aria-hidden="true" /> Try again
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

      <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
        <div className="grid h-20 w-20 shrink-0 place-items-center rounded-3xl bg-surface-2 text-brand-500">
          <Pill className="h-9 w-9" aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <RxBadge rx={p.rxClassification} />
            <Badge tone="neutral">{p.type === 'HEALTH_PRODUCT' ? 'Health product' : 'Medicine'}</Badge>
            {controlled && <Badge tone="danger">Controlled: {humanize(p.controlledSchedule)}</Badge>}
          </div>
          <h1 className="mt-2 font-display text-h1 text-fg">{name}</h1>
          {p.nameAm && p.nameAm !== name && <p lang="am" className="text-body-lg text-muted">{p.nameAm}</p>}
          {p.genericName && p.genericName !== name && <p className="text-body text-muted">{p.genericName}</p>}
        </div>
      </div>

      {p.status === 'DEPRECATED' && (
        <Card role="note" className="flex items-start gap-3 border-warning/40 p-4">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-warning" aria-hidden="true" />
          <p className="text-body text-muted">This product has been discontinued in the PharmaLink catalog and no longer appears in search.</p>
        </Card>
      )}

      {p.rxClassification === 'RX' && (
        <Card role="note" className="flex items-start gap-3 p-4">
          <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-warning" aria-hidden="true" />
          <p className="text-body text-muted">Prescription-only medicine. A valid prescription and pharmacist review are required.</p>
        </Card>
      )}

      <div className="grid gap-5 lg:grid-cols-5">
        <div className="space-y-5 lg:col-span-3">
          <Card className="px-5">
            <dl className="divide-y divide-border">
              <Row label="Brand">{p.brandName}</Row>
              <Row label="Generic name">{p.genericName}</Row>
              <Row label="Dosage form">{humanize(p.dosageForm)}</Row>
              <Row label="Strength">{strength(p)}</Row>
              <Row label="Pack size">{p.packSize}</Row>
              <Row label="Classification">
                {p.rxClassification === 'RX' ? 'Prescription only (Rx)' : p.rxClassification === 'OTC' ? 'Over the counter (OTC)' : null}
              </Row>
              <Row label="Storage">
                {p.storageRequirement && (
                  <span className="inline-flex items-center gap-1.5">
                    <Thermometer className="h-4 w-4 text-muted" aria-hidden="true" /> {humanize(p.storageRequirement)}
                  </span>
                )}
              </Row>
              {referencePrice && (
                <Row label="Catalog reference price">
                  {referencePrice}
                  <span className="block text-caption text-subtle">Platform reference only, not a pharmacy selling price.</span>
                </Row>
              )}
            </dl>
          </Card>

          {p.warnings && (
            <Card className="p-5">
              <div className="flex items-center gap-2">
                <AlertTriangle className="h-5 w-5 text-warning" aria-hidden="true" />
                <h2 className="text-h3 text-fg">Warnings</h2>
              </div>
              <p className="mt-2 whitespace-pre-line text-body text-muted">{p.warnings}</p>
            </Card>
          )}

          {(p.descriptionEn || p.descriptionAm) && (
            <Card className="p-5">
              <h2 className="text-h3 text-fg">About this product</h2>
              {p.descriptionEn && <p className="mt-2 whitespace-pre-line text-body text-muted">{p.descriptionEn}</p>}
              {p.descriptionAm && <p lang="am" className="mt-2 whitespace-pre-line text-body text-muted">{p.descriptionAm}</p>}
            </Card>
          )}

          <p className="text-caption text-subtle">
            Product information comes from the PharmaLink catalog. It is not medical advice; ask a pharmacist or doctor before use.
          </p>

          {p.categories.length > 0 && (
            <div className="flex flex-wrap gap-2" aria-label="Categories">
              {p.categories.map((c) => (
                <Link key={c.id} to={`/medicines?category=${c.id}`}>
                  <Badge tone="brand">{categoryName(c)}</Badge>
                </Link>
              ))}
            </div>
          )}
        </div>

        <div className="lg:col-span-2">
          <Availability product={p} />
        </div>
      </div>
    </div>
  )
}
