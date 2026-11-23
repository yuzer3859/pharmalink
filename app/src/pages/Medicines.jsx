import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useLocation, useSearchParams } from 'react-router-dom'
import { motion } from 'framer-motion'
import { Search, Upload, ShieldCheck, X, ChevronLeft, ChevronRight, RefreshCw, PackageSearch, ArrowRight } from 'lucide-react'
import { Button, Card, Badge, Input, Segmented, IconTile, Skeleton } from '../components/ui'
import { cn } from '../lib/utils'
import { PAGE_SIZE, PRODUCT_TYPES, RX_CLASSES, SORTS, isUuid, useCatalog } from '../catalog/catalogService'
import { flattenCategories, productDetailsLine, productName } from '../catalog/format'
import { t } from '../auth/strings'
import ProductImage from '../components/ProductImage'
import { formatMinorUnits } from '../lib/utils'

const SEARCH_DEBOUNCE_MS = 350

// Labels are message keys, read with t() when drawn (Work 143).
const typeOptions = [
  { value: '', label: 'medicines.kind.all' },
  { value: 'MEDICINE', label: 'common.medicines' },
  { value: 'HEALTH_PRODUCT', label: 'medicines.kind.health' },
]
const rxOptions = [
  { value: '', label: 'common.any' },
  { value: 'RX', label: 'common.rx' },
  { value: 'OTC', label: 'common.otc' },
]
const sortOptions = [
  { value: 'relevance', label: 'medicines.sort.relevance' },
  { value: 'name_asc', label: 'medicines.sort.name' },
  { value: 'newest', label: 'medicines.sort.newest' },
]
const translated = (options) => options.map((o) => ({ ...o, label: t(o.label) }))

/** The listing's state lives in the URL, so a product page can link back to the same results. */
function readFilters(params) {
  const page = Number(params.get('page'))
  return {
    q: (params.get('q') ?? '').slice(0, 100),
    type: PRODUCT_TYPES.includes(params.get('type')) ? params.get('type') : '',
    rx: RX_CLASSES.includes(params.get('rx')) ? params.get('rx') : '',
    categoryId: isUuid(params.get('category')) ? params.get('category') : '',
    sort: SORTS.includes(params.get('sort')) ? params.get('sort') : 'relevance',
    page: Number.isInteger(page) && page > 1 ? page : 1,
  }
}

export function RxBadge({ rx, className }) {
  if (rx === 'RX') return <Badge tone="warning" className={className}>{t('medicines.rxRequired')}</Badge>
  if (rx === 'OTC') return <Badge tone="success" className={className}>OTC</Badge>
  return null
}

/** Badges laid over a picture get a frosted backing so they stay readable on any photo. */
const ON_PICTURE = '!bg-white/90 shadow-sm backdrop-blur dark:!bg-slate-900/80'

/**
 * Work 147: an image-first product card. The picture zooms gently on hover and the card lifts; a
 * price shows when the caller has one (search results carry the lowest pharmacy price).
 */
export function ProductCard({ product, from, price = null, currency = 'ETB' }) {
  const details = productDetailsLine(product)
  const priceLabel = price == null ? null : formatMinorUnits(price, currency)
  return (
    <motion.div whileHover={{ y: -4 }} transition={{ type: 'spring', stiffness: 320, damping: 24 }} className="h-full">
      <Card interactive className="group h-full overflow-hidden">
        <Link
          to={`/medicines/${product.id}`}
          state={{ from }}
          className="flex h-full flex-col rounded-2xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
        >
          <div className="relative">
            <ProductImage src={product.imageUrl} zoom className="aspect-square w-full" />
            <div className="absolute left-2.5 top-2.5 flex flex-col items-start gap-1">
              <RxBadge rx={product.rxClassification} className={ON_PICTURE} />
              {product.type === 'HEALTH_PRODUCT' && <Badge tone="info" className={ON_PICTURE}>{t('common.healthProduct')}</Badge>}
            </div>
            <div className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-black/10 to-transparent opacity-0 transition-opacity duration-500 group-hover:opacity-100" />
          </div>
          <div className="flex flex-1 flex-col p-4">
            <p className="line-clamp-2 text-body font-semibold leading-snug text-fg">{productName(product)}</p>
            {details && <p className="mt-0.5 line-clamp-1 text-caption text-muted">{details}</p>}
            {product.manufacturerName && <p className="mt-0.5 line-clamp-1 text-caption text-subtle">{product.manufacturerName}</p>}
            <div className="mt-auto flex items-end justify-between gap-2 pt-3">
              {priceLabel ? (
                <p className="font-display text-body-lg font-bold text-fg" data-testid="card-price">{priceLabel}</p>
              ) : (
                <span className="text-caption font-semibold text-brand-600 dark:text-brand-300">{t('medicines.viewDetails')}</span>
              )}
              <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-brand-500/10 text-brand-600 transition-all duration-300 group-hover:translate-x-0.5 group-hover:bg-brand-500 group-hover:text-white dark:text-brand-300">
                <ArrowRight className="h-4 w-4" aria-hidden="true" />
              </span>
            </div>
          </div>
        </Link>
      </Card>
    </motion.div>
  )
}

function useCategories(catalog) {
  const [state, setState] = useState({ status: 'loading', tree: [] })
  useEffect(() => {
    const controller = new AbortController()
    catalog
      .getCategoryTree({ signal: controller.signal })
      .then((tree) => setState({ status: 'ready', tree }))
      .catch((error) => error?.code !== 'ABORTED' && setState({ status: 'error', tree: [] }))
    return () => controller.abort()
  }, [catalog])
  return state
}

export default function Medicines() {
  const catalog = useCatalog()
  const location = useLocation()
  const [params, setParams] = useSearchParams()
  const filters = useMemo(() => readFilters(params), [params])
  const [text, setText] = useState(filters.q)
  const [results, setResults] = useState({ status: 'loading', items: [], meta: null, error: null })
  const [attempt, setAttempt] = useState(0)
  const categories = useCategories(catalog)
  const categoryOptions = useMemo(() => flattenCategories(categories.tree, filters.type), [categories.tree, filters.type])
  const latest = useRef(0)

  function update(changes, { resetPage = true } = {}) {
    setParams((current) => {
      const next = new URLSearchParams(current)
      for (const [key, value] of Object.entries(changes)) {
        if (value) next.set(key, String(value))
        else next.delete(key)
      }
      if (resetPage) next.delete('page')
      return next
    }, { replace: true })
  }

  // Debounced search: the request goes out once typing pauses.
  useEffect(() => {
    if (text.trim() === filters.q.trim()) return undefined
    const timer = setTimeout(() => update({ q: text.trim() }), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text])

  // A newer query aborts the older request, and only the latest request may set results.
  useEffect(() => {
    const id = ++latest.current
    const controller = new AbortController()
    setResults((r) => ({ ...r, status: 'loading', error: null }))
    catalog
      .searchProducts({ ...filters, size: PAGE_SIZE }, { signal: controller.signal })
      .then((data) => {
        if (id === latest.current) setResults({ status: 'ready', items: data.items, meta: data.meta, error: null })
      })
      .catch((error) => {
        if (id === latest.current && error?.code !== 'ABORTED') {
          setResults({ status: 'error', items: [], meta: null, error })
        }
      })
    return () => controller.abort()
  }, [catalog, filters, attempt])

  // A category that doesn't apply to the chosen type is dropped rather than silently ignored.
  useEffect(() => {
    if (categories.status === 'ready' && filters.categoryId && !categoryOptions.some((c) => c.id === filters.categoryId)) {
      update({ category: '' })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [categories.status, categoryOptions, filters.categoryId])

  const hasFilters = Boolean(filters.q || filters.type || filters.rx || filters.categoryId)
  const total = results.meta?.total ?? 0
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const from = `/medicines${location.search}`

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-2">
        <h1 className="font-display text-h1 text-fg">{t('medicines.title')}</h1>
        <p className="text-body text-muted">{t('medicines.subtitle')}</p>
      </div>

      <Card className="flex items-center gap-4 border-dashed p-4 sm:p-5">
        <IconTile icon={Upload} size={48} tone="accent" />
        <div className="flex-1">
          <p className="text-body-lg font-semibold text-fg">{t('common.uploadPrescription')}</p>
          <p className="text-caption text-muted">{t('medicines.rx.soon')}</p>
        </div>
        <Button as={Link} to="/requests/new" variant="soft" size="sm">{t('common.sendPrescription')}</Button>
      </Card>

      {/* Search + filters */}
      <div className="sticky top-16 z-20 -mx-4 space-y-3 bg-bg/80 px-4 py-3 backdrop-blur sm:mx-0 sm:rounded-2xl sm:px-4">
        <form role="search" onSubmit={(e) => { e.preventDefault(); update({ q: text.trim() }) }} className="relative">
          <Input
            icon={Search}
            type="search"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={t('medicines.search.placeholder')}
            aria-label={t('medicines.search.label')}
            maxLength={100}
            className="pr-11"
          />
          {text && (
            <button
              type="button"
              onClick={() => { setText(''); update({ q: '' }) }}
              aria-label={t('medicines.search.clear')}
              className="absolute right-1.5 top-1/2 grid h-8 w-8 -translate-y-1/2 place-items-center rounded-lg text-subtle hover:bg-surface-2 hover:text-fg"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </form>
        <div className="flex flex-wrap items-center gap-2">
          <Segmented options={translated(typeOptions)} value={filters.type} onChange={(v) => update({ type: v })} />
          <div role="group" aria-label={t('medicines.filter.class')} className="flex flex-wrap gap-2">
            {rxOptions.map((o) => (
              <button
                key={o.value || 'any'}
                type="button"
                aria-pressed={filters.rx === o.value}
                onClick={() => update({ rx: o.value })}
                className={cn(
                  'whitespace-nowrap rounded-full border px-3.5 py-1.5 text-caption font-semibold transition-colors',
                  filters.rx === o.value
                    ? 'border-brand-500 bg-brand-500/12 text-brand-700 dark:text-brand-300'
                    : 'border-border bg-surface text-muted hover:text-fg',
                )}
              >
                {t(o.label)}
              </button>
            ))}
          </div>
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="flex items-center gap-2 text-caption font-semibold text-muted">
            <span className="shrink-0">{t('medicines.filter.category')}</span>
            <select
              value={filters.categoryId}
              onChange={(e) => update({ category: e.target.value })}
              disabled={categories.status !== 'ready' || categoryOptions.length === 0}
              className="h-10 w-full rounded-xl border border-border bg-surface px-3 text-body text-fg focus:border-brand-500 focus-visible:outline-none disabled:opacity-60"
            >
              <option value="">
                {t(categories.status === 'loading' ? 'common.loadingCategories'
                  : categories.status === 'error' ? 'medicines.categories.unavailable'
                    : categoryOptions.length === 0 ? 'medicines.categories.none' : 'medicines.categories.all')}
              </option>
              {categoryOptions.map((c) => (
                <option key={c.id} value={c.id}>{`${'  '.repeat(c.depth)}${c.label}`}</option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-2 text-caption font-semibold text-muted">
            <span className="shrink-0">{t('medicines.sort')}</span>
            <select
              value={filters.sort}
              onChange={(e) => update({ sort: e.target.value === 'relevance' ? '' : e.target.value })}
              className="h-10 w-full rounded-xl border border-border bg-surface px-3 text-body text-fg focus:border-brand-500 focus-visible:outline-none"
            >
              {sortOptions.map((o) => <option key={o.value} value={o.value}>{t(o.label)}</option>)}
            </select>
          </label>
        </div>
        {filters.categoryId && (
          <p className="text-caption text-subtle">{t('medicines.category.note')}</p>
        )}
      </div>

      {/* Results */}
      <div aria-live="polite" aria-busy={results.status === 'loading'}>
        {results.status === 'loading' && (
          <div role="status" className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-3 xl:grid-cols-4">
            <span className="sr-only">{t('common.loadingProducts')}</span>
            {Array.from({ length: 8 }, (_, i) => <Skeleton key={i} className="aspect-[3/4] rounded-2xl" />)}
          </div>
        )}

        {results.status === 'error' && (
          <Card role="alert" className="flex flex-col items-center gap-3 p-8 text-center">
            <p className="text-body-lg font-semibold text-fg">{t('medicines.loadFailed')}</p>
            <p className="text-body text-muted">
              {t(results.error?.code === 'NETWORK_ERROR' ? 'common.offline' : 'common.catalogError')}
            </p>
            <Button variant="secondary" onClick={() => setAttempt((n) => n + 1)}>
              <RefreshCw className="h-4 w-4" aria-hidden="true" /> {t('common.tryAgain')}
            </Button>
          </Card>
        )}

        {results.status === 'ready' && results.items.length === 0 && (
          <Card className="flex flex-col items-center gap-3 p-8 text-center">
            <IconTile icon={PackageSearch} size={48} />
            <p className="text-body-lg font-semibold text-fg">
              {t(hasFilters ? 'medicines.noMatch' : 'common.catalogEmpty')}
            </p>
            <p className="text-body text-muted">
              {t(hasFilters ? 'medicines.noMatch.hint' : 'medicines.empty.hint')}
            </p>
            {hasFilters && (
              <Button variant="secondary" onClick={() => { setText(''); update({ q: '', type: '', rx: '', category: '' }) }}>
                {t('medicines.clearAll')}
              </Button>
            )}
          </Card>
        )}

        {results.status === 'ready' && results.items.length > 0 && (
          <div className="space-y-4">
            <p className="text-caption text-muted">
              {t(total === 1 ? 'medicines.count.one' : 'medicines.count.many', { count: total })}
              {pages > 1 && ` ${t('medicines.countPage', { page: filters.page, pages })}`}
            </p>
            <motion.div layout className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-3 xl:grid-cols-4">
              {results.items.map((p) => (
                <motion.div layout key={p.id} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
                  <ProductCard product={p} from={from} />
                </motion.div>
              ))}
            </motion.div>
            {pages > 1 && (
              <nav aria-label={t('medicines.pagination')} className="flex items-center justify-center gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={filters.page <= 1}
                  onClick={() => update({ page: filters.page - 1 }, { resetPage: false })}
                >
                  <ChevronLeft className="h-4 w-4" aria-hidden="true" /> {t('common.previous')}
                </Button>
                <span className="text-caption text-muted">{t('common.pageOf', { page: filters.page, pages })}</span>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={filters.page >= pages}
                  onClick={() => update({ page: filters.page + 1 }, { resetPage: false })}
                >
                  {t('common.next')} <ChevronRight className="h-4 w-4" aria-hidden="true" />
                </Button>
              </nav>
            )}
          </div>
        )}
      </div>

      <div className="flex items-center justify-center gap-2 rounded-2xl bg-brand-500/8 p-4 text-caption text-muted">
        <ShieldCheck className="h-4 w-4 text-brand-500" />
        {t('medicines.rxFooter')}
      </div>
    </div>
  )
}
