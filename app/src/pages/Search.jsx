import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { MapPin, RefreshCw, PackageSearch, ArrowRight, Navigation, TrendingUp } from 'lucide-react'
import ProductImage from '../components/ProductImage'
import SearchSuggestBox from '../components/SearchSuggestBox'
import { Button, Card, Badge, Segmented, Skeleton } from '../components/ui'
import { formatMinorUnits } from '../lib/utils'
import { RxBadge } from './Medicines'
import { SEARCH_PAGE_SIZE, requestLocation, useSearch } from '../search/searchService'
import { t } from '../auth/strings'

const SEARCH_DEBOUNCE_MS = 350

// Labels are message keys, read with t() when drawn (Work 143).
const rxOptions = [
  { value: '', label: 'common.any' },
  { value: 'RX', label: 'common.rx' },
  { value: 'OTC', label: 'common.otc' },
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
  return meters < 1000 ? `${meters} m` : `${(meters / 1000).toFixed(1)} km`
}

function ResultCard({ hit }) {
  const a = hit.availability
  const details = [hit.genericName && hit.genericName !== hit.nameEn ? hit.genericName : null, hit.strength, hit.dosageForm]
    .filter(Boolean)
    .join(' · ')
  return (
    <Card interactive className="group">
      <Link
        to={`/medicines/${hit.productId}`}
        state={{ from: '/search' }}
        className="flex items-start gap-4 rounded-2xl p-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 sm:p-4"
      >
        <ProductImage src={hit.imageUrl} zoom iconSize="h-6 w-6" className="h-20 w-20 shrink-0 rounded-2xl sm:h-24 sm:w-24" />
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
                {a.pharmacyCount === 1 ? t('search.pharmacies.one') : t('search.pharmacies.many', { count: a.pharmacyCount })}{' '}
                {t('search.from', { price: formatMinorUnits(a.minPrice, a.currency) })}
                {distance(a.nearestDistanceMeters) ? ` ${t('search.nearest', { distance: distance(a.nearestDistanceMeters) })}` : ''}
              </span>
            ) : (
              <span className="text-muted">{t(hit.availability.nearestDistanceMeters === null ? 'search.notNow' : 'search.notNearby')}</span>
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
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const filters = useMemo(() => readFilters(params), [params])
  const [text, setText] = useState(filters.q)
  const [results, setResults] = useState({ status: 'loading', items: [], total: 0, match: null, didYouMean: null, error: null })
  const [trending, setTrending] = useState([])
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
      .then((data) => id === latest.current && setResults({ status: 'ready', items: data.items, total: data.total, match: data.match, didYouMean: data.didYouMean, error: null }))
      .catch((error) => id === latest.current && error?.code !== 'ABORTED' && setResults({ status: 'error', items: [], total: 0, match: null, didYouMean: null, error }))
    return () => controller.abort()
  }, [search, filters, attempt])

  // Work 159: this week's popular searches, offered while the box is empty. None when unavailable.
  const showTrending = filters.q === ''
  useEffect(() => {
    if (!showTrending) return undefined
    const controller = new AbortController()
    search
      .trending({ signal: controller.signal })
      .then(setTrending)
      .catch(() => setTrending([]))
    return () => controller.abort()
  }, [search, showTrending])

  function searchFor(q) {
    setText(q)
    update({ q })
  }

  function pickSuggestion(item) {
    if (item.kind === 'PRODUCT') navigate(`/medicines/${item.id}`, { state: { from: '/search' } })
    else searchFor(item.text)
  }

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
        <h1 className="font-display text-h1 text-fg">{t('search.title')}</h1>
        <p className="text-body text-muted">{t('search.subtitle')}</p>
      </div>

      <div className="space-y-3">
        <SearchSuggestBox
          label={t('search.label')}
          placeholder={t('search.placeholder')}
          value={text}
          onChange={setText}
          onPick={pickSuggestion}
          suggest={search.suggest}
        />
        <div className="flex flex-wrap items-center gap-3">
          <Segmented options={rxOptions.map((o) => ({ ...o, label: t(o.label) }))} value={filters.rx} onChange={(rx) => update({ rx })} />
          {filters.location ? (
            <>
              <Badge tone="info"><MapPin className="h-3.5 w-3.5" aria-hidden="true" /> {t('search.nearYou')}</Badge>
              <label className="flex items-center gap-2 text-caption text-muted">
                <input type="checkbox" checked={filters.availableOnly} onChange={(e) => update({ available: e.target.checked ? '1' : '' })} />
                {t('search.nearbyOnly')}
              </label>
              <Button variant="ghost" size="sm" onClick={() => update({ lat: '', lng: '', available: '' })}>{t('search.clearLocation')}</Button>
            </>
          ) : (
            <Button variant="secondary" size="sm" onClick={nearMe} disabled={locating}>
              <Navigation className="h-4 w-4" aria-hidden="true" /> {t(locating ? 'checkout.location.finding' : 'search.nearMe')}
            </Button>
          )}
        </div>
        {showTrending && trending.length > 0 && (
          <div className="flex flex-wrap items-center gap-2" aria-label={t('search.trending')} role="group">
            <span className="flex items-center gap-1 text-caption text-muted">
              <TrendingUp className="h-3.5 w-3.5" aria-hidden="true" /> {t('search.trending')}
            </span>
            {trending.map((term) => (
              <Button key={term} variant="secondary" size="sm" onClick={() => searchFor(term)}>{term}</Button>
            ))}
          </div>
        )}
        {locationRefused && (
          <p role="status" className="text-caption text-muted">{t('search.noLocation')}</p>
        )}
      </div>

      <section aria-live="polite" aria-busy={results.status === 'loading'}>
        {results.status === 'loading' && (
          <div className="space-y-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-24" />)}</div>
        )}
        {results.status === 'error' && (
          <Card className="flex flex-col items-center gap-3 p-8 text-center">
            <p className="text-body text-fg">{t('search.unavailable')}</p>
            <Button variant="secondary" size="sm" onClick={() => setAttempt((n) => n + 1)}>
              <RefreshCw className="h-4 w-4" aria-hidden="true" /> {t('common.tryAgain')}
            </Button>
          </Card>
        )}
        {results.status === 'ready' && results.items.length === 0 && (
          <Card className="flex flex-col items-center gap-2 p-8 text-center">
            <PackageSearch className="h-8 w-8 text-subtle" aria-hidden="true" />
            <p className="text-body text-fg">{filters.q ? t('search.noMatch.query', { query: filters.q }) : t('search.noMatch.filters')}</p>
          </Card>
        )}
        {results.status === 'ready' && results.items.length > 0 && (
          <div className="space-y-3">
            {results.match === 'SIMILAR' && results.didYouMean && (
              <div role="status" className="flex flex-wrap items-center gap-2 rounded-2xl bg-brand-50 px-4 py-3 text-body text-fg">
                <span>{t('search.didYouMean', { query: filters.q, suggestion: results.didYouMean })}</span>
                <Button variant="ghost" size="sm" onClick={() => searchFor(results.didYouMean)}>
                  {t('search.searchFor', { suggestion: results.didYouMean })}
                </Button>
              </div>
            )}
            <p className="text-caption text-muted">{results.total === 1 ? t('search.count.one') : t('search.count.many', { count: results.total })}</p>
            {results.items.map((hit) => <ResultCard key={hit.productId} hit={hit} />)}
            {pages > 1 && (
              <div className="flex items-center justify-between pt-2">
                <Button variant="ghost" size="sm" disabled={filters.page <= 1} onClick={() => update({ page: filters.page - 1 }, { resetPage: false })}>{t('common.previous')}</Button>
                <span className="text-caption text-muted">{t('common.pageOf', { page: filters.page, pages })}</span>
                <Button variant="ghost" size="sm" disabled={filters.page >= pages} onClick={() => update({ page: filters.page + 1 }, { resetPage: false })}>{t('common.next')}</Button>
              </div>
            )}
          </div>
        )}
      </section>

      <p className="text-caption text-subtle">
        {t('search.browse')} <Link to="/medicines" className="font-semibold text-brand-600">{t('search.catalogue')}</Link>
      </p>
    </div>
  )
}
