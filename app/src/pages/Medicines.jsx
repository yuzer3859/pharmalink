import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useLocation, useSearchParams } from 'react-router-dom'
import { motion } from 'framer-motion'
import { Search, Pill, Upload, ShieldCheck, X, ChevronLeft, ChevronRight, RefreshCw, PackageSearch, ArrowRight } from 'lucide-react'
import { Button, Card, Badge, Input, Segmented, IconTile, Skeleton } from '../components/ui'
import { cn } from '../lib/utils'
import { PAGE_SIZE, PRODUCT_TYPES, RX_CLASSES, SORTS, isUuid, useCatalog } from '../catalog/catalogService'
import { flattenCategories, productDetailsLine, productName } from '../catalog/format'

const SEARCH_DEBOUNCE_MS = 350

const typeOptions = [
  { value: '', label: 'All products' },
  { value: 'MEDICINE', label: 'Medicines' },
  { value: 'HEALTH_PRODUCT', label: 'Health products' },
]
const rxOptions = [
  { value: '', label: 'Any' },
  { value: 'RX', label: 'Prescription (Rx)' },
  { value: 'OTC', label: 'Over the counter' },
]
const sortOptions = [
  { value: 'relevance', label: 'Relevance' },
  { value: 'name_asc', label: 'Name A–Z' },
  { value: 'newest', label: 'Newest' },
]

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

export function RxBadge({ rx }) {
  if (rx === 'RX') return <Badge tone="warning">Rx required</Badge>
  if (rx === 'OTC') return <Badge tone="success">OTC</Badge>
  return null
}

export function ProductCard({ product, from }) {
  const details = productDetailsLine(product)
  return (
    <Card interactive className="h-full">
      <Link
        to={`/medicines/${product.id}`}
        state={{ from }}
        className="flex h-full flex-col rounded-2xl p-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
      >
        <div className="mb-3 flex items-start justify-between gap-2">
          <div className="grid h-14 w-14 place-items-center rounded-2xl bg-surface-2 text-brand-500">
            <Pill className="h-6 w-6" aria-hidden="true" />
          </div>
          <div className="flex flex-col items-end gap-1">
            <RxBadge rx={product.rxClassification} />
            {product.type === 'HEALTH_PRODUCT' && <Badge tone="info">Health product</Badge>}
          </div>
        </div>
        <p className="text-body-lg font-semibold text-fg">{productName(product)}</p>
        {details && <p className="text-caption text-muted">{details}</p>}
        {product.manufacturerName && <p className="mt-1 text-caption text-subtle">{product.manufacturerName}</p>}
        <span className="mt-auto inline-flex items-center gap-1 pt-4 text-caption font-semibold text-brand-600 dark:text-brand-300">
          View details & availability <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
        </span>
      </Link>
    </Card>
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
        <h1 className="font-display text-h1 text-fg">Medicines & health products</h1>
        <p className="text-body text-muted">Browse the PharmaLink catalog and see which pharmacy listings are available.</p>
      </div>

      <Card className="flex items-center gap-4 border-dashed p-4 sm:p-5">
        <IconTile icon={Upload} size={48} tone="accent" />
        <div className="flex-1">
          <p className="text-body-lg font-semibold text-fg">Upload a prescription</p>
          <p className="text-caption text-muted">Prescription upload and pharmacist review are coming soon.</p>
        </div>
        <Button variant="soft" size="sm" disabled aria-disabled="true">Coming soon</Button>
      </Card>

      {/* Search + filters */}
      <div className="sticky top-16 z-20 -mx-4 space-y-3 bg-bg/80 px-4 py-3 backdrop-blur sm:mx-0 sm:rounded-2xl sm:px-4">
        <form role="search" onSubmit={(e) => { e.preventDefault(); update({ q: text.trim() }) }} className="relative">
          <Input
            icon={Search}
            type="search"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Search by product or generic name"
            aria-label="Search products"
            maxLength={100}
            className="pr-11"
          />
          {text && (
            <button
              type="button"
              onClick={() => { setText(''); update({ q: '' }) }}
              aria-label="Clear search"
              className="absolute right-1.5 top-1/2 grid h-8 w-8 -translate-y-1/2 place-items-center rounded-lg text-subtle hover:bg-surface-2 hover:text-fg"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </form>
        <div className="flex flex-wrap items-center gap-2">
          <Segmented options={typeOptions} value={filters.type} onChange={(v) => update({ type: v })} />
          <div role="group" aria-label="Prescription classification" className="flex flex-wrap gap-2">
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
                {o.label}
              </button>
            ))}
          </div>
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="flex items-center gap-2 text-caption font-semibold text-muted">
            <span className="shrink-0">Category</span>
            <select
              value={filters.categoryId}
              onChange={(e) => update({ category: e.target.value })}
              disabled={categories.status !== 'ready' || categoryOptions.length === 0}
              className="h-10 w-full rounded-xl border border-border bg-surface px-3 text-body text-fg focus:border-brand-500 focus-visible:outline-none disabled:opacity-60"
            >
              <option value="">
                {categories.status === 'loading' ? 'Loading categories…'
                  : categories.status === 'error' ? 'Categories unavailable'
                    : categoryOptions.length === 0 ? 'No categories yet' : 'All categories'}
              </option>
              {categoryOptions.map((c) => (
                <option key={c.id} value={c.id}>{`${'  '.repeat(c.depth)}${c.label}`}</option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-2 text-caption font-semibold text-muted">
            <span className="shrink-0">Sort</span>
            <select
              value={filters.sort}
              onChange={(e) => update({ sort: e.target.value === 'relevance' ? '' : e.target.value })}
              className="h-10 w-full rounded-xl border border-border bg-surface px-3 text-body text-fg focus:border-brand-500 focus-visible:outline-none"
            >
              {sortOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </label>
        </div>
        {filters.categoryId && (
          <p className="text-caption text-subtle">Shows products assigned directly to this category, not to its subcategories.</p>
        )}
      </div>

      {/* Results */}
      <div aria-live="polite" aria-busy={results.status === 'loading'}>
        {results.status === 'loading' && (
          <div role="status" className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-3 xl:grid-cols-4">
            <span className="sr-only">Loading products…</span>
            {Array.from({ length: 8 }, (_, i) => <Skeleton key={i} className="h-44 rounded-2xl" />)}
          </div>
        )}

        {results.status === 'error' && (
          <Card role="alert" className="flex flex-col items-center gap-3 p-8 text-center">
            <p className="text-body-lg font-semibold text-fg">We couldn't load the catalog.</p>
            <p className="text-body text-muted">
              {results.error?.code === 'NETWORK_ERROR'
                ? 'PharmaLink could not be reached. Check your connection and try again.'
                : 'The catalog service returned an error. Please try again.'}
            </p>
            <Button variant="secondary" onClick={() => setAttempt((n) => n + 1)}>
              <RefreshCw className="h-4 w-4" aria-hidden="true" /> Try again
            </Button>
          </Card>
        )}

        {results.status === 'ready' && results.items.length === 0 && (
          <Card className="flex flex-col items-center gap-3 p-8 text-center">
            <IconTile icon={PackageSearch} size={48} />
            <p className="text-body-lg font-semibold text-fg">
              {hasFilters ? 'No products match your search.' : 'The catalog has no products yet.'}
            </p>
            <p className="text-body text-muted">
              {hasFilters ? 'Try another name or remove a filter.' : 'Products appear here once they are approved in the PharmaLink catalog.'}
            </p>
            {hasFilters && (
              <Button variant="secondary" onClick={() => { setText(''); update({ q: '', type: '', rx: '', category: '' }) }}>
                Clear search and filters
              </Button>
            )}
          </Card>
        )}

        {results.status === 'ready' && results.items.length > 0 && (
          <div className="space-y-4">
            <p className="text-caption text-muted">
              <span className="font-semibold text-fg">{total}</span> {total === 1 ? 'product' : 'products'}
              {pages > 1 && ` · page ${filters.page} of ${pages}`}
            </p>
            <motion.div layout className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-3 xl:grid-cols-4">
              {results.items.map((p) => (
                <motion.div layout key={p.id} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
                  <ProductCard product={p} from={from} />
                </motion.div>
              ))}
            </motion.div>
            {pages > 1 && (
              <nav aria-label="Pagination" className="flex items-center justify-center gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={filters.page <= 1}
                  onClick={() => update({ page: filters.page - 1 }, { resetPage: false })}
                >
                  <ChevronLeft className="h-4 w-4" aria-hidden="true" /> Previous
                </Button>
                <span className="text-caption text-muted">Page {filters.page} of {pages}</span>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={filters.page >= pages}
                  onClick={() => update({ page: filters.page + 1 }, { resetPage: false })}
                >
                  Next <ChevronRight className="h-4 w-4" aria-hidden="true" />
                </Button>
              </nav>
            )}
          </div>
        )}
      </div>

      <div className="flex items-center justify-center gap-2 rounded-2xl bg-brand-500/8 p-4 text-caption text-muted">
        <ShieldCheck className="h-4 w-4 text-brand-500" />
        Prescription items require pharmacist verification before dispatch.
      </div>
    </div>
  )
}
