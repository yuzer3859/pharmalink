import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { FlaskConical, Search as SearchIcon, MapPin, Navigation, RefreshCw } from 'lucide-react'
import { Badge, Button, Card, Input, Segmented, Skeleton } from '../components/ui'
import { PageHero, StaggerItem, StaggerList } from '../components/PageHero'
import { PAGE_PICTURES } from '../catalog/images'
import { formatMinorUnits } from '../lib/utils'
import { requestLocation } from '../search/searchService'
import { CARE_PAGE_SIZE, SERVICE_TYPES, distanceLabel, useCare } from '../care/careService'
import { t } from '../auth/strings'

const DEBOUNCE_MS = 350

function readFilters(params) {
  const lat = Number(params.get('lat'))
  const lng = Number(params.get('lng'))
  const page = Number(params.get('page'))
  const location = params.has('lat') && params.has('lng') && Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null
  return {
    q: (params.get('q') ?? '').slice(0, 120),
    serviceType: SERVICE_TYPES.includes(params.get('kind')) ? params.get('kind') : '',
    location,
    sort: params.get('sort') === 'distance' && location ? 'distance' : 'price',
    page: Number.isInteger(page) && page > 1 ? page : 1,
  }
}

/**
 * Work 165: compare lab tests, imaging and screening packages across labs and diagnostic centres
 * (Work 162) — cheapest first, or nearest first after "Near me" — each with its preparation and
 * the provider offering it. Booking a test online comes with Module 11.
 */
export default function Diagnostics() {
  const care = useCare()
  const [params, setParams] = useSearchParams()
  const filters = useMemo(() => readFilters(params), [params])
  const [text, setText] = useState(filters.q)
  const [results, setResults] = useState({ status: 'loading', items: [], total: 0, didYouMean: null })
  const [attempt, setAttempt] = useState(0)
  const [locating, setLocating] = useState(false)
  const [noLocation, setNoLocation] = useState(false)
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
    const timer = setTimeout(() => update({ q: text.trim() }), DEBOUNCE_MS)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text])

  useEffect(() => {
    const id = ++latest.current
    const controller = new AbortController()
    setResults((r) => ({ ...r, status: 'loading' }))
    care
      .searchServices(filters, { signal: controller.signal })
      .then((data) => id === latest.current && setResults({ status: 'ready', ...data }))
      .catch((error) => id === latest.current && error?.code !== 'ABORTED' && setResults({ status: 'error', items: [], total: 0, didYouMean: null }))
    return () => controller.abort()
  }, [care, filters, attempt])

  async function nearMe() {
    setLocating(true)
    setNoLocation(false)
    const location = await requestLocation()
    setLocating(false)
    if (!location) return setNoLocation(true)
    update({ lat: location.lat, lng: location.lng, sort: 'distance' })
  }

  const pages = Math.max(1, Math.ceil(results.total / CARE_PAGE_SIZE))
  const kindOptions = [{ value: '', label: t('common.any') }, ...SERVICE_TYPES.map((value) => ({ value, label: t(`diagnostics.kind.${value}`) }))]
  const sortOptions = [
    { value: 'price', label: t('diagnostics.sort.price') },
    { value: 'distance', label: t('diagnostics.sort.distance') },
  ]

  return (
    <div className="space-y-6">
      <PageHero icon={FlaskConical} title={t('diagnostics.title')} subtitle={t('diagnostics.subtitle')} pictures={PAGE_PICTURES.diagnostics} />

      <div className="space-y-3">
        <Input type="search" role="searchbox" aria-label={t('diagnostics.search')} icon={SearchIcon} placeholder={t('diagnostics.placeholder')} value={text} onChange={(e) => setText(e.target.value)} />
        <div className="flex flex-wrap items-center gap-3">
          <Segmented options={kindOptions} value={filters.serviceType} onChange={(kind) => update({ kind })} />
          {filters.location ? (
            <>
              <Segmented options={sortOptions} value={filters.sort} onChange={(sort) => update({ sort })} />
              <Badge tone="info"><MapPin className="h-3.5 w-3.5" aria-hidden="true" /> {t('search.nearYou')}</Badge>
              <Button variant="ghost" size="sm" onClick={() => update({ lat: '', lng: '', sort: '' })}>{t('search.clearLocation')}</Button>
            </>
          ) : (
            <Button variant="secondary" size="sm" onClick={nearMe} disabled={locating}>
              <Navigation className="h-4 w-4" aria-hidden="true" /> {t(locating ? 'checkout.location.finding' : 'search.nearMe')}
            </Button>
          )}
        </div>
        {noLocation && <p role="status" className="text-caption text-muted">{t('care.noLocation')}</p>}
      </div>

      <section aria-live="polite" aria-busy={results.status === 'loading'}>
        {results.status === 'loading' && <div className="space-y-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-20" />)}</div>}
        {results.status === 'error' && (
          <Card className="flex flex-col items-center gap-3 p-8 text-center">
            <p className="text-body text-fg">{t('search.unavailable')}</p>
            <Button variant="secondary" size="sm" onClick={() => setAttempt((n) => n + 1)}>
              <RefreshCw className="h-4 w-4" aria-hidden="true" /> {t('common.tryAgain')}
            </Button>
          </Card>
        )}
        {results.status === 'ready' && results.items.length === 0 && (
          <Card className="p-8 text-center text-body text-fg">{filters.q ? t('diagnostics.noMatch.query', { query: filters.q }) : t('diagnostics.noMatch.filters')}</Card>
        )}
        {results.status === 'ready' && results.items.length > 0 && (
          <div className="space-y-3">
            {results.didYouMean && (
              <p role="status" className="rounded-2xl bg-brand-50 px-4 py-3 text-body text-fg">{t('search.didYouMean', { query: filters.q, suggestion: results.didYouMean })}</p>
            )}
            <StaggerList className="space-y-3">
              {results.items.map((s) => {
                const distance = distanceLabel(s.distanceMeters)
                return (
                  <StaggerItem key={s.serviceId}>
                    <Card className="flex flex-col gap-2 p-4 sm:flex-row sm:items-start">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="text-body-lg font-semibold text-fg">{s.name}</p>
                          <Badge>{t(`diagnostics.kind.${s.serviceType}`)}</Badge>
                        </div>
                        <Link to={`/care/${s.provider.providerId}`} className="text-caption font-semibold text-brand-600">{s.provider.name}</Link>
                        <p className="text-caption text-muted">{[s.locationName, s.city, distance ? t('care.away', { distance }) : null].filter(Boolean).join(' · ')}</p>
                        {s.preparationInstructions && <p className="mt-1 text-caption text-subtle">{t('diagnostics.prepare', { text: s.preparationInstructions })}</p>}
                      </div>
                      <p className="shrink-0 text-body-lg font-semibold text-fg">{s.price === null ? t('care.priceOnRequest') : formatMinorUnits(s.price, s.currency)}</p>
                    </Card>
                  </StaggerItem>
                )
              })}
            </StaggerList>
            {pages > 1 && (
              <div className="flex items-center justify-between pt-2">
                <Button variant="ghost" size="sm" disabled={filters.page <= 1} onClick={() => update({ page: filters.page - 1 }, { resetPage: false })}>{t('common.previous')}</Button>
                <span className="text-caption text-muted">{t('common.pageOf', { page: filters.page, pages })}</span>
                <Button variant="ghost" size="sm" disabled={filters.page >= pages} onClick={() => update({ page: filters.page + 1 }, { resetPage: false })}>{t('common.next')}</Button>
              </div>
            )}
            <p className="text-caption text-subtle">{t('care.bookingLater')}</p>
          </div>
        )}
      </section>
    </div>
  )
}
