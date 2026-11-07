import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Search as SearchIcon, MapPin, Pill, RefreshCw, PackageSearch, ArrowRight, Navigation } from 'lucide-react'
import { Button, Card, Badge, Input, Segmented, Skeleton } from '../components/ui'
import { formatMinorUnits } from '../lib/utils'
import { RxBadge } from './Medicines'
import { SEARCH_PAGE_SIZE, requestLocation, useSearch } from '../search/searchService'

const SEARCH_DEBOUNCE_MS = 350

const rxOptions = [
  { value: '', label: 'Any' },
  { value: 'RX', label: 'Prescription (Rx)' },
  { value: 'OTC', label: 'Over the counter' },
]

function readFilters(params) {
  const page = Number(params.get('page'))
  const lat = Number(params.get('lat'))
  const lng = Number(params.get('lng'))
  return {
    q: (params.get('q') ?? '').slice(0, 120),
    rx: ['RX', 'OTC'].includes(params.get('rx')) ? params.get('rx') : '',
    location: params.has('lat') && params.has('lng') && Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null,
    availableOnly: params.get('available') === '1',
    page: Number.isInteger(page) && page > 1 ? page : 1,
  }
}

function distance(meters) {
  if (meters == null) return null
  return meters < 1000 ? `${meters} m away` : `${(meters / 1000).toFixed(1)} km away`
}

function ResultCard({ hit }) {
  const a = hit.availability
  const details = [hit.genericName && hit.genericName !== hit.nameEn ? hit.genericName : null, hit.strength, hit.dosageForm]
    .filter(Boolean)
    .join(' · ')
  return (
    <Card interactive>
      <Link
        to={`/medicines/${hit.productId}`}
        state={{ from: '/search' }}
        className="flex items-start gap-4 rounded-2xl p-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
      >
        <div className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl bg-surface-2 text-brand-500">
          <Pill className="h-5 w-5" aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-body-lg font-semibold text-fg">{hit.nameEn || hit.genericName || hit.nameAm}</p>
            <RxBadge rx={hit.rxClassification} />
          </div>
          {hit.nameAm && hit.nameAm !== hit.nameEn && <p className="text-caption text-muted" lang="am">{hit.nameAm}</p>}
          {details && <p className="text-caption text-muted">{details}</p>}
          <p className="mt-2 text-caption" data-testid="availability">
            {a.pharmacyCount > 0 ? (
              <span className="text-success">
                {a.pharmacyCount === 1 ? '1 pharmacy' : `${a.pharmacyCount} pharmacies`} · from {formatMinorUnits(a.minPrice, a.currency)}
                {distance(a.nearestDistanceMeters) ? ` · nearest ${distance(a.nearestDistanceMeters)}` : ''}
              </span>
            ) : (
              <span className="text-muted">Not available {hit.availability.nearestDistanceMeters === null ? 'right now' : 'nearby'}</span>
            )}
          </p>
        </div>
        <ArrowRight className="mt-1 h-4 w-4 shrink-0 text-subtle" aria-hidden="true" />
      </Link>
    </Card>
  )
}

/**
 * Work 99: search medicines by English or Amharic name with live availability (Module 14,
 * Work 98). The location is asked for only when the customer taps "Near me", and lives only in
 * the URL of this page.
 */
export default function SearchPage() {
  const search = useSearch()
  const [params, setParams] = useSearchParams()
  const filters = useMemo(() => readFilters(params), [params])
  const [text, setText] = useState(filters.q)
  const [results, setResults] = useState({ status: 'loading', items: [], total: 0, error: null })
  const [attempt, setAttempt] = useState(0)
  const [locating, setLocating] = useState(false)
  const [locationRefused, setLocationRefused] = useState(false)
  const latest = useRef(0)

  function update(changes, { resetPage = true } = {}) {
    setParams((current) => {
      const next = new URLSearchParams(current)
      for (const [key, value] of Object.entries(changes)) {
        if (value === '' || value === null || value === undefined || value === false) next.delete(key)
        else next.set(key, String(value))
      }
      if (resetPage) next.delete('page')
      return next
    }, { replace: true })
  }

  useEffect(() => {
    if (text.trim() === filters.q.trim()) return undefined
    const timer = setTimeout(() => update({ q: text.trim() }), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text])

  useEffect(() => {
    const id = ++latest.current
    const controller = new AbortController()
    setResults((r) => ({ ...r, status: 'loading', error: null }))
    search
      .searchMedicines({ ...filters, size: SEARCH_PAGE_SIZE }, { signal: controller.signal })
      .then((data) => id === latest.current && setResults({ status: 'ready', items: data.items, total: data.total, error: null }))
      .catch((error) => id === latest.current && error?.code !== 'ABORTED' && setResults({ status: 'error', items: [], total: 0, error }))
    return () => controller.abort()
  }, [search, filters, attempt])

  async function nearMe() {
    setLocating(true)
    setLocationRefused(false)
    const location = await requestLocation()
    setLocating(false)
    if (!location) return setLocationRefused(true)
    update({ lat: location.lat, lng: location.lng })
  }

  const pages = Math.max(1, Math.ceil(results.total / SEARCH_PAGE_SIZE))

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-h1 text-fg">Search</h1>
        <p className="text-body text-muted">Find a medicine by its English or Amharic name and see which pharmacies have it now.</p>
      </div>

      <div className="space-y-3">
        <Input
          type="search"
          role="searchbox"
          aria-label="Search medicines"
          icon={SearchIcon}
          placeholder="e.g. paracetamol, ፓራሲታሞል"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <div className="flex flex-wrap items-center gap-3">
          <Segmented options={rxOptions} value={filters.rx} onChange={(rx) => update({ rx })} />
          {filters.location ? (
            <>
              <Badge tone="info"><MapPin className="h-3.5 w-3.5" aria-hidden="true" /> Near you</Badge>
              <label className="flex items-center gap-2 text-caption text-muted">
                <input type="checkbox" checked={filters.availableOnly} onChange={(e) => update({ available: e.target.checked ? '1' : '' })} />
                Available nearby only
              </label>
              <Button variant="ghost" size="sm" onClick={() => update({ lat: '', lng: '', available: '' })}>Clear location</Button>
            </>
          ) : (
            <Button variant="secondary" size="sm" onClick={nearMe} disabled={locating}>
              <Navigation className="h-4 w-4" aria-hidden="true" /> {locating ? 'Finding you…' : 'Near me'}
            </Button>
          )}
        </div>
        {locationRefused && (
          <p role="status" className="text-caption text-muted">Your location isn't available, so results are not sorted by distance.</p>
        )}
      </div>

      <section aria-live="polite" aria-busy={results.status === 'loading'}>
        {results.status === 'loading' && (
          <div className="space-y-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-24" />)}</div>
        )}
        {results.status === 'error' && (
          <Card className="flex flex-col items-center gap-3 p-8 text-center">
            <p className="text-body text-fg">Search isn't available right now.</p>
            <Button variant="secondary" size="sm" onClick={() => setAttempt((n) => n + 1)}>
              <RefreshCw className="h-4 w-4" aria-hidden="true" /> Try again
            </Button>
          </Card>
        )}
        {results.status === 'ready' && results.items.length === 0 && (
          <Card className="flex flex-col items-center gap-2 p-8 text-center">
            <PackageSearch className="h-8 w-8 text-subtle" aria-hidden="true" />
            <p className="text-body text-fg">No medicines match {filters.q ? `“${filters.q}”` : 'these filters'}.</p>
          </Card>
        )}
        {results.status === 'ready' && results.items.length > 0 && (
          <div className="space-y-3">
            <p className="text-caption text-muted">{results.total === 1 ? '1 result' : `${results.total} results`}</p>
            {results.items.map((hit) => <ResultCard key={hit.productId} hit={hit} />)}
            {pages > 1 && (
              <div className="flex items-center justify-between pt-2">
                <Button variant="ghost" size="sm" disabled={filters.page <= 1} onClick={() => update({ page: filters.page - 1 }, { resetPage: false })}>Previous</Button>
                <span className="text-caption text-muted">Page {filters.page} of {pages}</span>
                <Button variant="ghost" size="sm" disabled={filters.page >= pages} onClick={() => update({ page: filters.page + 1 }, { resetPage: false })}>Next</Button>
              </div>
            )}
          </div>
        )}
      </section>

      <p className="text-caption text-subtle">
        Prefer to browse? <Link to="/medicines" className="font-semibold text-brand-600">See the full catalogue</Link>
      </p>
    </div>
  )
}
